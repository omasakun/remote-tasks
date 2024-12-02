// Copyright 2024 omasakun <omasakun@o137.net>.
//
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import chalk from 'chalk'
import { Command } from 'commander'
import { execa, Options, parseCommandString } from 'execa'
import fetch, { RequestInit } from 'node-fetch'
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import prompts from 'prompts'
import stripJsonComments from 'strip-json-comments'
import { z } from 'zod'

const HEARTBEAT_INTERVAL_MS = 30000 // 30 seconds
const STALE_THRESHOLD_MS = 60000 // 1 minute
const LOG_INTERVAL_MS = 10000 // 10 seconds
const RUN_INTERVAL_MS = 30000 // 30 seconds

// #region WorkerClient

type NewTask = z.infer<typeof newTaskSchema>
type Task = z.infer<typeof taskSchema>
type Log = z.infer<typeof logSchema>

const newTaskSchema = z.object({
  tag: z.string(),
  task: z.string(),
  status: z.string(),
})

const taskSchema = z.object({
  id: z.number(),
  tag: z.string(),
  task: z.string(),
  status: z.string(),
})

const logSchema = z.object({
  task_id: z.number(),
  log: z.string(),
})

const okSchema = z.object({
  ok: z.literal(true),
})

class ResponseError extends Error {
  status: number
  details: any

  constructor(message: string, status: number, details: any) {
    super(message)
    this.status = status
    this.details = details
  }
}

class WorkerClient {
  private baseUrl: string
  private authHeader: string

  constructor(baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    schema: z.ZodSchema<T>,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
    })
    const data = await response.text()
    if (!response.ok) {
      throw new ResponseError(
        `Request failed with status ${response.status}`,
        response.status,
        data,
      )
    }
    const json = JSON.parse(data)
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new ResponseError(`Response parsing failed`, 500, parsed.error)
    }
    return parsed.data
  }

  async getTags(): Promise<string[]> {
    return this.request('/tags', {}, z.array(z.string()))
  }

  async getTasks(): Promise<Task[]> {
    return this.request('/tasks', {}, z.array(taskSchema))
  }

  async createTask(task: NewTask): Promise<Task> {
    return this.request(
      '/tasks',
      {
        method: 'POST',
        body: JSON.stringify(task),
      },
      taskSchema,
    )
  }

  async deleteTasks(): Promise<number> {
    return this.request(
      '/tasks',
      {
        method: 'DELETE',
      },
      z.number(),
    )
  }

  async deleteCompletedTasks(): Promise<number> {
    return this.request(
      '/tasks/completed',
      {
        method: 'DELETE',
      },
      z.number(),
    )
  }

  async getTasksByTag(tag: string): Promise<Task[]> {
    return this.request(`/tasks/tag/${tag}`, {}, z.array(taskSchema))
  }

  async deleteTasksByTag(tag: string): Promise<number> {
    return this.request(
      `/tasks/tag/${tag}`,
      {
        method: 'DELETE',
      },
      z.number(),
    )
  }

  async deleteCompletedTasksByTag(tag: string): Promise<number> {
    return this.request(
      `/tasks/tag/${tag}/completed`,
      {
        method: 'DELETE',
      },
      z.number(),
    )
  }

  async startNextTask(tag: string): Promise<Task | null> {
    return this.request(
      `/tasks/start/${tag}`,
      {
        method: 'POST',
      },
      z.union([taskSchema, z.literal(null)]),
    )
  }

  async getTaskById(id: number): Promise<Task> {
    return this.request(`/tasks/${id}`, {}, taskSchema)
  }

  async updateTask(task: Task): Promise<void> {
    await this.request(
      `/tasks/${task.id}`,
      {
        method: 'PUT',
        body: JSON.stringify(task),
      },
      okSchema,
    )
  }

  async deleteTask(id: number): Promise<void> {
    await this.request(
      `/tasks/${id}`,
      {
        method: 'DELETE',
      },
      okSchema,
    )
  }

  async appendLog(log: Log): Promise<void> {
    await this.request(
      '/logs',
      {
        method: 'POST',
        body: JSON.stringify(log),
      },
      okSchema,
    )
  }

  async getLogs(task_id: number): Promise<string[]> {
    return this.request(`/logs/${task_id}`, {}, z.array(z.string()))
  }
}

// #endregion

type Config = z.infer<typeof configSchema>

const configSchema = z.object({
  worker: z.string().url(),
  preTask: z.array(z.union([z.string(), z.array(z.string())])).optional(),
  defaultTag: z.string().optional(),
})

function loadConfig(configPath: string): Config {
  const configFile = fs.readFileSync(configPath, 'utf-8')
  const parsed = configSchema.safeParse(JSON.parse(stripJsonComments(configFile)))
  if (!parsed.success) {
    throw new Error(`Invalid config file: ${parsed.error}`)
  }
  return parsed.data
}

function loadPassword(worker_url: string): string {
  const password = process.env.REMOTE_TASKS_PASSWORD
  if (password !== undefined) return password

  try {
    const netrc = parseNetrc()
    const worker = new URL(worker_url).host
    const machine = netrc[worker]
    if (machine?.password) return machine.password
  } catch (error) {
    // Ignore error
  }

  throw new Error('Password not found in environment variable REMOTE_TASKS_PASSWORD or .netrc file')
}

function parseNetrc() {
  const netrcPath = path.join(homedir(), '.netrc')
  const netrcFile = fs.readFileSync(netrcPath, 'utf-8')
  const lines = netrcFile.split('\n')
  const machines: Record<string, { login?: string; password?: string }> = {}
  let currentMachine: string | null = null
  for (const lineWithComment of lines) {
    const line = lineWithComment.split('#')[0].trim()
    const parts = line.split(/[ \t]+/)
    if (line === '') continue
    if (parts[0] === 'machine') {
      currentMachine = parts[1]
      machines[currentMachine] = {}
    } else if (parts[0] === 'login') {
      machines[currentMachine!].login = parts[1]
    } else if (parts[0] === 'password') {
      machines[currentMachine!].password = parts[1]
    }
  }
  return machines
}

let config: Config
let client: WorkerClient

const program = new Command()
  .enablePositionalOptions()
  .description('A simple way to execute tasks on remote machines')
  .option('-c, --config <path>', 'Path to config file', 'remote-tasks.json')
  .hook('preAction', () => {
    const options = program.opts()
    const configPath = path.resolve(options.config)
    config = loadConfig(configPath)
    const password = loadPassword(config.worker)
    client = new WorkerClient(config.worker, 'client', password)
  })

program
  .command('add')
  .description('Schedule a task')
  .passThroughOptions(true)
  .option('--tag <tag>', 'Tag for the task')
  .argument('<command...>', 'Command to execute')
  .action(async (command: string[], { tag }: { tag?: string }) => {
    if (!tag) {
      tag = config.defaultTag
    }
    if (!tag) {
      throw new Error('Tag is required')
    }

    const task: NewTask = {
      tag,
      task: JSON.stringify({ command, exitCode: null, lastHeartbeat: null }),
      status: 'pending',
    }
    const createdTask = await client.createTask(task)
    console.log('Task created with ID:', createdTask.id)
  })

program
  .command('remove')
  .description('Remove tasks by IDs')
  .argument('<ids...>', 'IDs of tasks to remove')
  .action(async (ids: string[]) => {
    await Promise.all(
      ids.map(async (id) => {
        await client.deleteTask(Number(id))
        console.log('Task removed with ID:', id)
      }),
    )
  })

program
  .command('requeue')
  .description('Requeue tasks by IDs')
  .argument('<ids...>', 'IDs of tasks to requeue')
  .action(async (ids: string[]) => {
    await Promise.all(
      ids.map(async (id) => {
        const task = await client.getTaskById(Number(id))
        task.status = 'pending'
        task.task = JSON.stringify({
          ...JSON.parse(task.task),
          exitCode: null,
          lastHeartbeat: null,
        })
        await client.updateTask(task)
        console.log('Task requeued with ID:', id)
      }),
    )
  })

program
  .command('tags')
  .description('List all tags')
  .action(async () => {
    const tags = await client.getTags()
    tags.forEach((tag) => console.log(tag))
  })

program
  .command('list')
  .description('List tasks, optionally filtered by tag')
  .option('--tag <tag>', 'Tag to filter tasks')
  .action(async ({ tag }: { tag?: string }) => {
    const tasks = tag ? await client.getTasksByTag(tag) : await client.getTasks()
    tasks.forEach((task) => {
      const taskData = JSON.parse(task.task)
      const lastHeartbeat = taskData.lastHeartbeat ? new Date(taskData.lastHeartbeat) : null
      const exitCode = taskData.exitCode ? ` with exit code ${taskData.exitCode}` : ''
      const isStale = lastHeartbeat && Date.now() - lastHeartbeat.getTime() > STALE_THRESHOLD_MS
      const status = isStale ? 'stale' : task.status
      const color =
        {
          done: chalk.green,
          running: chalk.blue,
          stale: chalk.yellow,
        }[status] || chalk.gray
      console.log(color(`#${task.id} [${task.tag}, ${status}${exitCode}]`))
      console.log(`> ${taskData.command.join(' ')}`)
    })
  })

async function runNextTask(tag: string): Promise<boolean> {
  const task = await client.startNextTask(tag)
  if (!task) {
    console.log('No tasks to run')
    return false
  }

  const taskData = JSON.parse(task.task)
  const { command } = taskData

  // Execute pre-task commands if configured
  if (config.preTask) {
    for (const preTaskCommand of config.preTask) {
      const command = Array.isArray(preTaskCommand)
        ? preTaskCommand
        : parseCommandString(preTaskCommand)
      await execa({ stdio: 'inherit' })`${command}`
    }
  }

  const logs: { type: string; data: string }[] = []

  const child = execa({
    stdout: {
      binary: true,
      transform: async function* (data: unknown) {
        if (!(data instanceof Uint8Array)) throw new Error('Expected Uint8Array')
        process.stdout.write(data)
        const base64 = Buffer.from(data).toString('base64')
        logs.push({ type: 'stdout', data: base64 })
      },
    },
    stderr: {
      binary: true,
      transform: async function* (data: unknown) {
        if (!(data instanceof Uint8Array)) throw new Error('Expected Uint8Array')
        process.stderr.write(data)
        const base64 = Buffer.from(data).toString('base64')
        logs.push({ type: 'stderr', data: base64 })
      },
    },
  } satisfies Options)`${command}`

  const sendLogs = async () => {
    if (logs.length > 0) {
      const log = JSON.stringify({
        timestamp: new Date().toISOString(),
        entries: logs,
      })
      logs.length = 0
      await client.appendLog({
        task_id: task.id,
        log,
      })
    }
  }

  const heartbeatInterval = setInterval(() => {
    taskData.lastHeartbeat = new Date().toISOString()
    client.updateTask({ ...task, task: JSON.stringify(taskData) })
  }, HEARTBEAT_INTERVAL_MS)

  const logInterval = setInterval(sendLogs, LOG_INTERVAL_MS)

  child.on('close', async (code) => {
    clearInterval(heartbeatInterval)
    clearInterval(logInterval)
    if (logs.length > 0) {
      await sendLogs()
    }
    taskData.exitCode = code
    task.status = 'done'
    await client.updateTask({ ...task, task: JSON.stringify(taskData) })
    console.log(`Task ${task.id} completed with exit code ${code}`)
  })
  return true
}

program
  .command('run')
  .description('Execute tasks from the queue')
  .option('--repeat', 'Run tasks in a loop')
  .option('--tag <tag>', 'Tag to filter tasks')
  .action(async ({ repeat, tag }: { repeat: boolean; tag?: string }) => {
    if (!tag) {
      tag = config.defaultTag
    }
    if (!tag) {
      throw new Error('Tag is required')
    }
    if (repeat) {
      while (true) {
        if (!(await runNextTask(tag))) {
          await new Promise((resolve) => setTimeout(resolve, RUN_INTERVAL_MS))
        }
      }
    } else {
      await runNextTask(tag)
    }
  })

program
  .command('tail')
  .description('Replay task logs')
  .option('--debug', 'Show debug logs')
  .argument('<task_id>', 'ID of the task to replay logs')
  .action(async (task_id: string, { debug }: { debug?: boolean }) => {
    const logs = await client.getLogs(Number(task_id))
    if (debug) {
      logs.forEach((log) => {
        const entry = JSON.parse(log)
        const timestamp = new Date(entry.timestamp).toISOString()
        entry.entries.forEach((entry: { type: string; data: string }) => {
          const data = Buffer.from(entry.data, 'base64').toString()
          console.log(`[${timestamp}] ${entry.type}: ${data}`)
        })
      })
    } else {
      logs.forEach((log) => {
        const entry = JSON.parse(log)
        entry.entries.forEach((entry: { type: string; data: string }) => {
          const data = Buffer.from(entry.data, 'base64')
          if (entry.type === 'stdout') {
            process.stdout.write(data)
          } else {
            process.stderr.write(data)
          }
        })
      })
    }
  })

program
  .command('clean')
  .description('Delete all completed tasks')
  .option('--force', 'Skip confirmation prompt')
  .option('--tag <tag>', 'Tag to filter tasks')
  .action(async ({ force, tag }: { force: boolean; tag?: string }) => {
    if (!force) {
      const message = tag
        ? `Delete all completed tasks with tag ${tag}?`
        : 'Delete all completed tasks?'
      const response = await prompts({
        type: 'confirm',
        name: 'value',
        message,
      })
      if (!response.value) return
    }
    const count = tag
      ? await client.deleteCompletedTasksByTag(tag)
      : await client.deleteCompletedTasks()
    console.log(`Deleted ${count} completed tasks`)
  })

program
  .command('reset')
  .description('Delete all tasks, optionally filtered by tag')
  .option('--force', 'Skip confirmation prompt')
  .option('--tag <tag>', 'Tag to filter tasks')
  .action(async ({ force, tag }: { force: boolean; tag?: string }) => {
    if (!force) {
      const message = tag ? `Delete all tasks with tag ${tag}?` : 'Delete all tasks?'
      const response = await prompts({
        type: 'confirm',
        name: 'value',
        message,
      })
      if (!response.value) return
      const message2 = "Are you really sure? This can't be undone!"
      const response2 = await prompts({
        type: 'toggle',
        name: 'value',
        message: message2,
        initial: false,
        active: 'yes',
        inactive: 'no',
      })
      if (!response2.value) return
    }
    const count = tag ? await client.deleteTasksByTag(tag) : await client.deleteTasks()
    console.log(`Deleted ${count} tasks`)
  })

program.parse(process.argv)

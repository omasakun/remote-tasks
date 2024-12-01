// Copyright 2024 omasakun <omasakun@o137.net>.
//
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
// If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Router } from 'itty-router'
import { z } from 'zod'

interface Env {
  BASIC_PASS: string
  D1: D1Database
}

const encoder = new TextEncoder()

function timingSafeEqual(a: string, b: string) {
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)

  // Strings must be the same length in order to compare with crypto.subtle.timingSafeEqual
  if (aBytes.byteLength !== bBytes.byteLength) return false
  return crypto.subtle.timingSafeEqual(aBytes, bBytes)
}

function basicAuth(request: Request, env: Env): boolean {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Basic ')) return false

  const base64Credentials = authHeader.split(' ')[1]
  const credentials = atob(base64Credentials).split(':')
  const password = credentials[1]

  return timingSafeEqual(password, env.BASIC_PASS)
}

const router = Router()

const taskSchema = z.object({
  tag: z.string(),
  task: z.string(),
  status: z.enum(['pending', 'running', 'done']),
})

const logSchema = z.object({
  task_id: z.number(),
  log: z.string(),
})

router.get('/tags', async (request, env: Env) => {
  const result = await env.D1.prepare('SELECT DISTINCT tag FROM tasks').all()
  const tags = result.results.map((row) => row.tag)
  return new Response(JSON.stringify(tags), { status: 200 })
})

router.get('/tasks', async (request, env: Env) => {
  const result = await env.D1.prepare('SELECT * FROM tasks').all()
  return new Response(JSON.stringify(result.results), { status: 200 })
})

router.post('/tasks', async (request, env: Env) => {
  const body = await request.json()
  const parsed = taskSchema.safeParse(body)
  if (!parsed.success) {
    return new Response(JSON.stringify(parsed.error.errors), { status: 400 })
  }
  const { tag, task, status } = parsed.data
  const result = await env.D1.prepare('INSERT INTO tasks (tag, task, status) VALUES (?, ?, ?)')
    .bind(tag, task, status)
    .run()
  const newTask = await env.D1.prepare('SELECT * FROM tasks WHERE id = ?')
    .bind(result.meta.last_row_id)
    .first()
  return new Response(JSON.stringify(newTask), { status: 201 })
})

router.delete('/tasks', async (request, env: Env) => {
  const result = await env.D1.prepare('DELETE FROM tasks').run()
  return new Response(JSON.stringify(result.meta.changes), { status: 200 })
})

router.delete('/tasks/completed', async (request, env: Env) => {
  const result = await env.D1.prepare('DELETE FROM tasks WHERE status = "done"').run()
  return new Response(JSON.stringify(result.meta.changes), { status: 200 })
})

router.get('/tasks/tag/:tag', async (request, env: Env) => {
  const { tag } = request.params
  const result = await env.D1.prepare('SELECT * FROM tasks WHERE tag = ?').bind(tag).all()
  return new Response(JSON.stringify(result.results), { status: 200 })
})

router.delete('/tasks/tag/:tag', async (request, env: Env) => {
  const { tag } = request.params
  const result = await env.D1.prepare('DELETE FROM tasks WHERE tag = ?').bind(tag).run()
  return new Response(JSON.stringify(result.meta.changes), { status: 200 })
})

router.delete('/tasks/tag/:tag/completed', async (request, env: Env) => {
  const { tag } = request.params
  const result = await env.D1.prepare('DELETE FROM tasks WHERE tag = ? AND status = "done"')
    .bind(tag)
    .run()
  return new Response(JSON.stringify(result.meta.changes), { status: 200 })
})

router.post('/tasks/start/:tag', async (request, env: Env) => {
  const { tag } = request.params
  const task = await env.D1.prepare(
    'SELECT * FROM tasks WHERE tag = ? AND status = "pending" ORDER BY id LIMIT 1',
  )
    .bind(tag)
    .first()
  if (task) {
    const updateResult = await env.D1.prepare(
      'UPDATE tasks SET status = "running" WHERE id = ? AND status = "pending"',
    )
      .bind(task.id)
      .run()
    if (!updateResult.meta.changed_db) {
      return new Response('Task status was already changed', { status: 409 })
    }
  }
  return new Response(JSON.stringify(task), { status: 200 })
})

router.get('/tasks/:id', async (request, env: Env) => {
  const { id } = request.params
  const result = await env.D1.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).all()
  return new Response(JSON.stringify(result.results), { status: 200 })
})

router.put('/tasks/:id', async (request, env: Env) => {
  const { id } = request.params
  const body = await request.json()
  const parsed = taskSchema.safeParse(body)
  if (!parsed.success) {
    return new Response(JSON.stringify(parsed.error.errors), { status: 400 })
  }
  const { tag, task, status } = parsed.data
  await env.D1.prepare('UPDATE tasks SET tag = ?, task = ?, status = ? WHERE id = ?')
    .bind(tag, task, status, id)
    .run()
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
})

router.delete('/tasks/:id', async (request, env: Env) => {
  const { id } = request.params
  await env.D1.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run()
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
})

router.post('/logs', async (request, env: Env) => {
  const body = await request.json()
  const parsed = logSchema.safeParse(body)
  if (!parsed.success) {
    return new Response(JSON.stringify(parsed.error.errors), { status: 400 })
  }
  const { task_id, log } = parsed.data
  await env.D1.prepare('INSERT INTO logs (task_id, log) VALUES (?, ?)').bind(task_id, log).run()
  return new Response(JSON.stringify({ ok: true }), { status: 201 })
})

router.get('/logs/:task_id', async (request, env: Env) => {
  const { task_id } = request.params
  const result = await env.D1.prepare('SELECT * FROM logs WHERE task_id = ?').bind(task_id).all()
  const logs = result.results.map((row) => row.log)
  return new Response(JSON.stringify(logs), { status: 200 })
})

router.get('*', () => new Response('Not found', { status: 404 }))

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.protocol !== 'https:') {
      return new Response('Please use HTTPS', { status: 400 })
    }
    if (!basicAuth(request, env)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="my scope", charset="UTF-8"',
        },
      })
    }
    return router.fetch(request, env, ctx)
  },
}

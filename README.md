<!-- TODO: Translation -->
<div align="center">
  <h1>Remote Tasks</h1>
  <p>A simple way to execute tasks on remote machines</p>
</div>
<br>
<br>

Remote task queue made with Cloudflare Workers & D1 database.

You can schedule tasks to run on remote machines with a simple command line interface.

## Usage

```bash
# Pass the password as an environment variable
# Alternatively, you can set the password in ~/.netrc file
export REMOTE_TASKS_PASSWORD=your_password

# Schedule a task
npx remote-tasks add --tag example echo "Hello World"

# List all tasks
npx remote-tasks list

# Run all tasks with the tag "example"
# (Run this command on the remote machine)
npx remote-tasks run --tag example --repeat

# Show help (there are more commands!)
npx remote-tasks --help
```

## Setup

Run the following commands to setup the cloudflare worker after cloning the repository.

```bash
npm exec wrangler d1 create  remote-tasks  # Update wrangler.toml accordingly
npm exec wrangler d1 execute remote-tasks --file worker/schema.sql
npm exec wrangler secret put BASIC_PASS    # Set a password for basic auth
npm exec wrangler deploy
```

## Configuration

Default configuration file is `remote-tasks.json`. You can change it by command line option.

```jsonc
{
  "$schema": "node_modules/remote-tasks/schema.json",
  "worker": "https://your-worker-url",
  "preTask": [
    // Commands to run before each task
    "git stash --include-untracked",
    "git checkout main",
    "git pull",
  ],
}
```

See [schema.json](./schema.json) for the schema definition.

## License

This project is licensed under [MPL-2.0](./LICENSE).

Copyright 2024 omasakun

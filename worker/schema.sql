-- Copyright 2024 omasakun <omasakun@o137.net>.
--
-- This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
-- If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

DROP TABLE IF EXISTS tasks;

DROP TABLE IF EXISTS logs;

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE INDEX tasks_tag_status ON tasks (tag, status);
CREATE INDEX tasks_tag ON tasks (tag);

CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  log TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX logs_task_id ON logs (task_id);

---
name: loop
description: Run a prompt on a schedule, such as every day at nine or every five minutes, and list or delete scheduled tasks
---

Use this skill when the person wants something to happen again and again: "check the deployment every morning", "every 5 minutes look at the build", "stop the daily report".

## How scheduled tasks work

- schedule_create {cron, prompt} saves a scheduled task for this folder. At each time the cron expression names, the background engine starts a new conversation in this folder, sends it the prompt, and puts a notice in the person's inbox when it ends.
- Each run is a fresh conversation. It knows nothing of this one, so write the prompt so that it stands alone: say what to check, where, and what to report.
- A time that passes while the engine is not running is not made up for. The person gets a notice that says how many runs were missed.
- Times are read in the time zone of this machine. There is no finer step than one minute.

## Turning a period into cron

A cron expression has five fields: minute, hour, day of month, month, day of week. A field is `*` for every value, a number, a list `1,15`, a range `1-5`, or a step `*/5`. Sunday is 0 or 7.

| The person says                      | cron          |
| ------------------------------------ | ------------- |
| every minute                         | `* * * * *`   |
| every 5 minutes                      | `*/5 * * * *` |
| every hour                           | `0 * * * *`   |
| every day at 9                       | `0 9 * * *`   |
| weekdays at 9                        | `0 9 * * 1-5` |
| every Monday at 8:30                 | `30 8 * * 1`  |
| the first of every month at midnight | `0 0 1 * *`   |

- If a request has no time ("keep checking"), ask how often before you create anything. If it says "daily" without an hour, ask for the hour.
- If the person gives a time in another time zone, convert it to this machine's time zone and say what you chose.
- If both day of month and day of week are set, a day matches when either does. Use only one of them unless that is what the person wants.

## Listing and deleting

- Before you delete, call schedule_list and show the person the matching tasks. Delete by id with schedule_delete only when one task clearly matches; if several could, ask which.
- To change a task, delete it and create a new one. Say that you did.
- After creating, tell the person the id and the next run time that schedule_create returned.

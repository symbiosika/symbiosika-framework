# Built-in Logging & Admin Log Endpoints

## Overview

The Fastapp Framework provides a comprehensive logging system out of the box. All essential features for collecting, storing, and managing logs are available, including API endpoints for administrators to download and clear logs. This system supports multiple log levels and outputs logs to both files and the database.

---

## Log Levels

The logging system supports the following log levels:

- **debug**: Detailed information for debugging purposes.
- **info**: General operational messages that highlight the progress of the application.
- **warn**: Indications of potential issues or important situations that are not errors.
- **error**: Error events that might still allow the application to continue running.

Log entries are stored with their level, source, category, message, and optional metadata.

---

## Log Outputs

Logs are written to:

- **Console**: All log messages are output to the server console.
- **Log Files**: If the environment variable `WRITE_DEBUG_FILES` is set to `true`, logs are also written to files in the `logs/` directory. The main log file is `app.log`, with automatic rotation (up to 10 files, 1MB each). Custom logs (e.g., per chat session) are written as `custom-<name>.log`.
- **Database**: Logs can also be written to the `app_logs` table in the database, including structured metadata.

---

## Admin Log Endpoints

All admin log endpoints require appropriate authentication and the `app:logs` scope.

### Download All Logs

- **GET `/api/v1/admin/logs/download`**
  - Downloads all available log files as a single compressed `.gz` archive.
  - The response is a gzip file containing all log file contents, each prefixed by its file name.

### Download Chat Session Logs

- **GET `/api/v1/admin/logs/chat/:id`**
  - Downloads logs for a specific chat session (by chat ID).
  - Returns the chat session data and its associated log content as JSON.

### Clear All Logs

- **POST `/api/v1/admin/logs/clear`**
  - Deletes all log files from the server.
  - Returns a success response if all logs are cleared.

---

## Example Log Entry (Database)

| Property        | Type      | Description                                 |
|----------------|-----------|---------------------------------------------|
| id             | uuid      | Unique log entry ID                         |
| level          | enum      | Log level: debug, info, warn, error         |
| source         | string    | Application component or service name       |
| category       | string    | Log category (e.g., security, performance)  |
| sessionId      | uuid      | Optional session ID                         |
| organisationId | uuid      | Optional organisation ID                    |
| message        | text      | Log message                                 |
| metadata       | jsonb     | Additional structured data                  |
| version        | integer   | Version (default: 0)                        |
| createdAt      | timestamp | Timestamp of log entry                      |

---

## Notes

- Log file rotation ensures that disk usage is limited (max 10 files, 1MB each).
- Custom logs can be created for specific sessions or features.
- All log endpoints are protected and require admin privileges.

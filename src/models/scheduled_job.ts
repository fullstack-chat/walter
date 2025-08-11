type ScheduledJob = {
  name: string
  cron: string
  execute: (now?: Date | "manual" | "init") => void | Promise<void>
  timezone?: string
}

export default ScheduledJob
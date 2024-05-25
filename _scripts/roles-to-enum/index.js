require("dotenv").config()
const fs = require('fs')

;(async () => {
  let res = await fetch(`https://discord.com/api/guilds/${process.env.GUILD_ID}`, {
    headers: {
      Authorization: `Bot ${process.env.BOT_TOKEN}`
    }
  })
  let json = await res.json()
  let roles = json.roles
  const map = {}
  for (const role of roles) {
    let name = role.name
    name = name.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '');
    name = name.trim()
    name = name.replace(/\s/g, "_")
    name = name.replace("@", "")
    name = name.replace(/\./g, "_")
    name = name.toUpperCase()
    map[role.id] = name
  }

  let content = "export enum Roles {\n"
  for (const key in map) {
    content += `  ${map[key]} = "${key}",\n`
  }
  content += "}"
  fs.writeFileSync("../../src/data/roles.ts", content)
})()
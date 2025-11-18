import { Logger } from "winston";
import XpRecord from "../models/xp_record";
import { db } from "../db/client";
import { userXp, users } from "../db/schema";
import { eq } from "drizzle-orm";

export default class XpManager {
  // userId: XpRecord
  data: { [key: string]: XpRecord } = {};
  // userId: faunaRecordId
  recordIds: { [key: string]: number } = {};
  log: Logger;
  faunaRecordId?: string;
  collectionName = "user_xp"

  // Constants
  private twentyFourHoursInMs = 86400000;
  private fiveMinInMs = 300000;
  private levelUpConst = 0.4;

  constructor(logger: Logger) {
    this.log = logger;
  }

  async init() {
    try {
      const records = await db.select().from(userXp);
      records.forEach((r: any) => {
        this.data[r.userId] = new XpRecord({
          userId: r.userId,
          lastAppliedTimestamp: r.lastAppliedTimestamp,
          currentXp: r.currentXp,
          multiplier: r.multiplier,
          username: r.username,
          penaltyCount: r.penaltyCount
        });
        this.recordIds[r.userId] = r.id;
      });
    } catch(err: any) {
      this.log.error(`xpService.init: ${err.toString()}`)
    }
  }

  async saveUser(userId: string, user: XpRecord, isNew: boolean, username: string) {
    if (isNew) {
      try {
        const inserted = await db.insert(userXp).values(user as any).returning();
        const record = inserted[0];
        // Persist local cache and record id
        this.data[userId] = user;
        this.recordIds[userId] = record.id;
        await db.insert(users).values({ userId, username });
      } catch (err: any) {
        this.log.error(`xpService.saveUser: ${err.toString()}`);
      }
    } else {
      try {
        await db.update(userXp)
          .set(user as any)
          .where(eq(userXp.id, this.recordIds[userId]));
        this.data[userId] = user;
      } catch (err: any) {
        this.log.error(`xpService.saveUser: ${err.toString()}`);
      }
    }
  }

  getXpForUserId(userId: string) {
    if (this.data[userId]) return this.data[userId].currentXp;
  }

  getLevelForUserId(userId: string): number {
    let currentXp = this.data[userId].currentXp;
    return this.getLevelByXp(currentXp);
  }

  async logXp(message: any, userId: string, username: string) {
    this.log.info(`Logging message for ${username} (${userId})`);
    let currentTimestamp = Date.now();
    let user = this.data[userId];
    let isNew = false;
    if (!user) {
      this.log.info("User not found, creating new...");
      isNew = true;
      user = new XpRecord({
        userId,
        lastAppliedTimestamp: currentTimestamp,
        currentXp: 0,
        multiplier: 1,
        username,
        penaltyCount: 0
      });
    }

    // Clear penalties
    if (!user.penaltyCount || user.penaltyCount > 0) {
      user.penaltyCount = 0;
    }

    // Five min timeout
    if (isNew || currentTimestamp - user.lastAppliedTimestamp > this.fiveMinInMs) {
      // If its been longer than 24 hours since we heard from you, reset the multiplier
      if (currentTimestamp - user.lastAppliedTimestamp > this.twentyFourHoursInMs) {
        this.log.info("Multipler getting reset...");
        user.multiplier = 1;
      } else if (user.lastAppliedTimestamp !== currentTimestamp && user.multiplier < 5) {
        this.log.info("Bumping multiplier!!!");
        user.multiplier++;
      } else {
        this.log.info("Maxium multiplier detected, go go user!");
      }
      let newXp = user.currentXp + user.multiplier;
      this.log.info(`Adding XP, was ${user.currentXp}, now is ${newXp}`);

      // Actually apply the xp
      let levelResults = this.processXpLevel(user.currentXp, newXp);
      if (levelResults.isLeveledUp) {
        message.channel.send(`🔼 **${username}** is now level **${levelResults.currentLevel}**!`);
      }

      // Automatically assign the active role
      if (levelResults.isTransitioningToActive) {
        try {
          await message.member.roles.add(process.env.ACTIVE_ROLE_ID);
          // let role = message.member.roles.cache.find(role => role.id === process.env.ACTIVE_ROLE_ID);
          // console.log(role)
          // if (role) {
          //   message.member.guild.roles.add(role);
          // }
        } catch (err) {
          console.log(err);
          this.log.error(err);
        }
      }

      user.currentXp = newXp;
      user.lastAppliedTimestamp = currentTimestamp;

      await this.saveUser(userId, user, isNew, username);
    } else {
      this.log.info("5 min timeout not hit, ignoring...");
    }
  }

  private processXpLevel(previousXp: number, newXp: number): { isLeveledUp: boolean; currentLevel: number; isTransitioningToActive: boolean } {
    let isTransitioningToActive = false;
    let oldLevel = this.getLevelByXp(previousXp);
    let newLevel = this.getLevelByXp(newXp);
    let isLeveledUp = false;
    if (newLevel > oldLevel) {
      isLeveledUp = true;

      if (newLevel >= 5) {
        isTransitioningToActive = true;
      }
    }
    return {
      isLeveledUp: isLeveledUp,
      currentLevel: newLevel,
      isTransitioningToActive,
    };
  }

  getUsersAtOrAboveXp(xp: number): string[] {
    let users: string[] = [];
    Object.keys(this.data).forEach(key => {
      if (this.data[key].currentXp >= xp) {
        users.push(this.data[key].username);
      }
    });
    return users;
  }

  getLeaderboardUsers(): XpRecord[] {
    return Object.values(this.data).sort((a, b) => b.currentXp - a.currentXp).splice(0, 10);
  }

  getLevelUpProgressPercentage(xp: number): number {
      let currentLevel = this.getLevelByXp(xp);      
      let currentLevelEntryXp = this.getXpByLevel(currentLevel)
      let nextLevelEntryXp = this.getXpByLevel(currentLevel + 1)
      
      let userXpProgress = xp - currentLevelEntryXp
      let xpGapBetweenLevels = nextLevelEntryXp - currentLevelEntryXp

      return userXpProgress * 100 / xpGapBetweenLevels
  }

  private getLevelByXp(xp: number): number {
    return Math.floor(this.levelUpConst * Math.sqrt(xp));
  }

  private getXpByLevel(level: number): number {
    return Math.ceil(Math.pow(level / this.levelUpConst, 2));
  }
}

// const FaunaService = require('./FaunaService')
// const log = require('../logger')

// const twentyFourHoursInMs = 86400000
// const fiveMinInMs = 300000;
// const levelUpConst = 0.4;
// const rowKey = 'xpdata'

// let data = {}

// // FaunaDB Implementation
// let _faunaService;
// let collectionName = "fsc-bot-data"
// let indexName = "idxByKey"
// let faunaRecordId;

// exports.init = async function () {
//   try {
//     _faunaService = new FaunaService(process.env.FAUNA_SECRET);
//     let record = await _faunaService.getRecordByIndex(indexName, rowKey);
//     faunaRecordId = record.id
//     data = record.document
//   } catch(err) {
//     log.error(`xpService.init: ${err.toString()}`)
//   }
// }

// const save = async function () {
//   try {
//     await _faunaService.updateRecord(collectionName, faunaRecordId, {
//       document: data
//     })
//   } catch(err) {
//     log.error(`xpService.save: ${err.toString()}`)
//   }
// }

// exports.getXpForUserId = function(userId) {
//   return data[userId].currentXp
// }

// exports.getLevelForUserId = function (userId) {
//   let currentXp = data[userId].currentXp
//   return getLevelByXp(currentXp)
// }

// const processXpLevel = function (previousXp, newXp) {
//   let isTransitioningToActive = false;
//   let oldLevel = getLevelByXp(previousXp)
//   let newLevel = getLevelByXp(newXp)
//   let isLeveledUp = false;
//   if(newLevel > oldLevel) {
//     isLeveledUp = true;

//     if(newLevel >= 5) {
//       isTransitioningToActive = true;
//     }
//   }
//   return {
//     isLeveledUp: isLeveledUp,
//     currentLevel: newLevel,
//     isTransitioningToActive
//   }
// }

/**
 * Returns an array of usernames at or above the given level
 * @param {Number} level
 */
// exports.getUsersAtOrAboveXp = function (xp) {
//   let users = []
//   Object.keys(data).forEach(key => {
//     if(data[key].currentXp >= xp) {
//       users.push(data[key].username)
//     }
//   })
//   return users
// }

/**
 * Calculates the level that the XP is currently
 * @param  {Number} xp - The XP to calculate
 */
// const getLevelByXp = function (xp) {
//   return Math.floor(levelUpConst * Math.sqrt(xp))
// }

/**
 * Calculates the XP required to get to the specified level
 * @returns {Number} The XP required
 * @param {Number} level - The level to calculate the required XP for
 */
// exports.getXpByLevel = function (level) {
//   return Math.ceil(Math.pow(level / levelUpConst, 2))
// }

// new logic:
// if the user hasnt messaged in 14 days, start counting penalties
// every 24 hours, doc 10% of xp until day 24, then set to 0
// if user has 0 xp for 7 days, kick and send message

// separate process
// on user join, create a record and set a penalty period
// after 30 days, if they havent reached level 5, kick with message

// /**
//  * Scans all users and determines if they should lose XP based on activity.
//  */
// exports.processDecrementXpScript = function() {
//   // Get all the users
//   let currentTimestamp = Date.now()
//   Object.keys(data).forEach(userId => {
//     let daysSinceContact = (currentTimestamp - data[userId].lastXpAppliedTimestamp) / twentyFourHoursInMs
//     let shouldDecrementXp = exports.shouldDecrementXp(daysSinceContact, data[userId].penaltyCount)

//     if(shouldDecrementXp) {
//       let decrementedXp = calculateDecrementedXp(data[userId].currentXp, daysSinceContact)
//       log.info(`[NO ACTION] Decrementing XP for user ${data[userId].username} from ${data[userId].currentXp} (${typeof(data[userId].currentXp)}) to ${decrementedXp} (${typeof(decrementedXp)})...`)
//       // data[userId].currentXp = decrementedXp
//       if(data[userId].penaltyCount) {
//         data[userId].penaltyCount++
//       } else {
//         data[userId].penaltyCount = 1
//       }
//     }
//   })
// }

// /**
//  * Calculates the new XP for the user
//  * @returns {Number} the new XP for the user
//  * @param  {Number} currentXp - The users current XP
//  * @param  {Number} daysSinceContact - Number of days since we last heard from the user
//  */
// const calculateDecrementedXp = function (currentXp, daysSinceContact) {
//   let decrementMultiplier = exports.calculateDecrementMultiplier(daysSinceContact)
//   return currentXp * decrementMultiplier
// }

// /**
//  * Calculates the multiplier for which the users XP should be decremented by
//  * @returns {Number} the calculated multiplier
//  * @param  {Number} daysSinceContact - Number of days since we last heard from the user
//  */
// exports.calculateDecrementMultiplier = function (daysSinceContact) {
//   let difference = ((daysSinceContact - 2) * 0.1).toFixed(1)
//   return (1 - difference).toFixed(1)
// }

// /**
//  * Determines if a user should have their XP decremented
//  * @returns {Boolean}
//  * @param  {Number} daysSinceContact - Number of days since we last heard from the user
//  * @param  {Number} penaltyCount - The users current penalty count
//  */
// exports.shouldDecrementXp = function (daysSinceContact, penaltyCount) {
//   if(!penaltyCount || penaltyCount == undefined || penaltyCount == null) {
//     penaltyCount = 0
//   }
//   daysSinceContact = Math.floor(daysSinceContact)

//   if(daysSinceContact > 12) {
//     return false;
//   }

//   return daysSinceContact === (penaltyCount + 3)
// }

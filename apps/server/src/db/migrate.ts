import { getDb, closeDb } from "./client.js";

getDb();
console.log("Database migrated.");
closeDb();

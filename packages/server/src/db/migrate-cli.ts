import { parseDatabaseConfig } from "../config.js";
import { migrateDatabase } from "./migrate.js";

const config = parseDatabaseConfig(process.env);
await migrateDatabase(config.databaseUrl, config.migrationsDirectory);

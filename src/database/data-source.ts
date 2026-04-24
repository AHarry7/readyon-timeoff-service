/**
 * data-source.ts
 *
 * This file is the entry point for the TypeORM CLI.
 * It is intentionally separate from the NestJS application bootstrap so that
 * migrations can be generated and run without starting the full NestJS DI
 * container.
 *
 * Usage:
 *   # Generate a new migration after editing entities
 *   npx typeorm-ts-node-commonjs migration:generate \
 *     src/database/migrations/InitialSchema -d src/database/data-source.ts
 *
 *   # Run pending migrations
 *   npx typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
 *
 *   # Revert the last migration
 *   npx typeorm-ts-node-commonjs migration:revert -d src/database/data-source.ts
 *
 * The DATABASE_PATH env var controls which SQLite file is targeted.
 * Defaults to 'timeoff.db' in the project root for local development.
 */

import "dotenv/config";
import { DataSource } from "typeorm";
import { buildDataSourceOptions } from "./database.module";

const dbPath = process.env.DATABASE_PATH ?? "timeoff.db";

export const AppDataSource = new DataSource({
  ...buildDataSourceOptions(dbPath),
  // Point the CLI at the TS source files, not the compiled JS.
  entities: ["src/database/entities/*.entity.ts"],
  migrations: ["src/database/migrations/*.ts"],
});

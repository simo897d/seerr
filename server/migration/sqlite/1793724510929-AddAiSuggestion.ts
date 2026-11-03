import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAiSuggestion1793724510929 implements MigrationInterface {
  name = 'AddAiSuggestion1793724510929';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_suggestion" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tmdbId" integer NOT NULL, "mediaType" varchar NOT NULL, "title" varchar NOT NULL, "year" integer, "reason" varchar NOT NULL DEFAULT (''), "outcome" varchar NOT NULL DEFAULT ('pending'), "timesShown" integer NOT NULL DEFAULT (1), "firstShownAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "lastShownAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "resolvedAt" datetime, "userId" integer, CONSTRAINT "UNIQUE_AI_SUGGESTION" UNIQUE ("userId", "tmdbId", "mediaType"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d546acbf4cc65976a2792f3705" ON "ai_suggestion" ("userId") `
    );
    await queryRunner.query(`DROP INDEX "IDX_d546acbf4cc65976a2792f3705"`);
    await queryRunner.query(
      `CREATE TABLE "temporary_ai_suggestion" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tmdbId" integer NOT NULL, "mediaType" varchar NOT NULL, "title" varchar NOT NULL, "year" integer, "reason" varchar NOT NULL DEFAULT (''), "outcome" varchar NOT NULL DEFAULT ('pending'), "timesShown" integer NOT NULL DEFAULT (1), "firstShownAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "lastShownAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "resolvedAt" datetime, "userId" integer, CONSTRAINT "UNIQUE_AI_SUGGESTION" UNIQUE ("userId", "tmdbId", "mediaType"), CONSTRAINT "FK_d546acbf4cc65976a2792f37050" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_ai_suggestion"("id", "tmdbId", "mediaType", "title", "year", "reason", "outcome", "timesShown", "firstShownAt", "lastShownAt", "resolvedAt", "userId") SELECT "id", "tmdbId", "mediaType", "title", "year", "reason", "outcome", "timesShown", "firstShownAt", "lastShownAt", "resolvedAt", "userId" FROM "ai_suggestion"`
    );
    await queryRunner.query(`DROP TABLE "ai_suggestion"`);
    await queryRunner.query(
      `ALTER TABLE "temporary_ai_suggestion" RENAME TO "ai_suggestion"`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d546acbf4cc65976a2792f3705" ON "ai_suggestion" ("userId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_d546acbf4cc65976a2792f3705"`);
    await queryRunner.query(
      `ALTER TABLE "ai_suggestion" RENAME TO "temporary_ai_suggestion"`
    );
    await queryRunner.query(
      `CREATE TABLE "ai_suggestion" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tmdbId" integer NOT NULL, "mediaType" varchar NOT NULL, "title" varchar NOT NULL, "year" integer, "reason" varchar NOT NULL DEFAULT (''), "outcome" varchar NOT NULL DEFAULT ('pending'), "timesShown" integer NOT NULL DEFAULT (1), "firstShownAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "lastShownAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "resolvedAt" datetime, "userId" integer, CONSTRAINT "UNIQUE_AI_SUGGESTION" UNIQUE ("userId", "tmdbId", "mediaType"))`
    );
    await queryRunner.query(
      `INSERT INTO "ai_suggestion"("id", "tmdbId", "mediaType", "title", "year", "reason", "outcome", "timesShown", "firstShownAt", "lastShownAt", "resolvedAt", "userId") SELECT "id", "tmdbId", "mediaType", "title", "year", "reason", "outcome", "timesShown", "firstShownAt", "lastShownAt", "resolvedAt", "userId" FROM "temporary_ai_suggestion"`
    );
    await queryRunner.query(`DROP TABLE "temporary_ai_suggestion"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_d546acbf4cc65976a2792f3705" ON "ai_suggestion" ("userId") `
    );
    await queryRunner.query(`DROP INDEX "IDX_d546acbf4cc65976a2792f3705"`);
    await queryRunner.query(`DROP TABLE "ai_suggestion"`);
  }
}

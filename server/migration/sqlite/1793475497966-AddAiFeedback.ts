import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAiFeedback1793475497966 implements MigrationInterface {
  name = 'AddAiFeedback1793475497966';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "title_feedback" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tmdbId" integer NOT NULL, "mediaType" varchar NOT NULL, "status" varchar NOT NULL, "title" varchar NOT NULL, "year" integer, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "userId" integer, CONSTRAINT "UNIQUE_TITLE_FEEDBACK" UNIQUE ("userId", "tmdbId", "mediaType"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1f358d83723eb66d67a896d07a" ON "title_feedback" ("userId") `
    );
    await queryRunner.query(
      `CREATE TABLE "temporary_user_settings" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "locale" varchar NOT NULL DEFAULT (''), "discoverRegion" varchar, "streamingRegion" varchar, "originalLanguage" varchar, "pgpKey" varchar, "discordIds" text, "pushbulletAccessToken" varchar, "pushoverApplicationToken" varchar, "pushoverUserKey" varchar, "pushoverSound" varchar, "telegramChatId" varchar, "telegramSendSilently" boolean, "watchlistSyncMovies" boolean, "watchlistSyncTv" boolean, "notificationTypes" text, "userId" integer, "telegramMessageThreadId" varchar, "aiKidsMode" boolean NOT NULL DEFAULT (0), "aiExcludedLibraries" text, CONSTRAINT "REL_986a2b6d3c05eb4091bb8066f7" UNIQUE ("userId"), CONSTRAINT "FK_986a2b6d3c05eb4091bb8066f78" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_user_settings"("id", "locale", "discoverRegion", "streamingRegion", "originalLanguage", "pgpKey", "discordIds", "pushbulletAccessToken", "pushoverApplicationToken", "pushoverUserKey", "pushoverSound", "telegramChatId", "telegramSendSilently", "watchlistSyncMovies", "watchlistSyncTv", "notificationTypes", "userId", "telegramMessageThreadId") SELECT "id", "locale", "discoverRegion", "streamingRegion", "originalLanguage", "pgpKey", "discordIds", "pushbulletAccessToken", "pushoverApplicationToken", "pushoverUserKey", "pushoverSound", "telegramChatId", "telegramSendSilently", "watchlistSyncMovies", "watchlistSyncTv", "notificationTypes", "userId", "telegramMessageThreadId" FROM "user_settings"`
    );
    await queryRunner.query(`DROP TABLE "user_settings"`);
    await queryRunner.query(
      `ALTER TABLE "temporary_user_settings" RENAME TO "user_settings"`
    );
    await queryRunner.query(`DROP INDEX "IDX_1f358d83723eb66d67a896d07a"`);
    await queryRunner.query(
      `CREATE TABLE "temporary_title_feedback" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tmdbId" integer NOT NULL, "mediaType" varchar NOT NULL, "status" varchar NOT NULL, "title" varchar NOT NULL, "year" integer, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "userId" integer, CONSTRAINT "UNIQUE_TITLE_FEEDBACK" UNIQUE ("userId", "tmdbId", "mediaType"), CONSTRAINT "FK_1f358d83723eb66d67a896d07a2" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_title_feedback"("id", "tmdbId", "mediaType", "status", "title", "year", "createdAt", "updatedAt", "userId") SELECT "id", "tmdbId", "mediaType", "status", "title", "year", "createdAt", "updatedAt", "userId" FROM "title_feedback"`
    );
    await queryRunner.query(`DROP TABLE "title_feedback"`);
    await queryRunner.query(
      `ALTER TABLE "temporary_title_feedback" RENAME TO "title_feedback"`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1f358d83723eb66d67a896d07a" ON "title_feedback" ("userId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_1f358d83723eb66d67a896d07a"`);
    await queryRunner.query(
      `ALTER TABLE "title_feedback" RENAME TO "temporary_title_feedback"`
    );
    await queryRunner.query(
      `CREATE TABLE "title_feedback" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tmdbId" integer NOT NULL, "mediaType" varchar NOT NULL, "status" varchar NOT NULL, "title" varchar NOT NULL, "year" integer, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "userId" integer, CONSTRAINT "UNIQUE_TITLE_FEEDBACK" UNIQUE ("userId", "tmdbId", "mediaType"))`
    );
    await queryRunner.query(
      `INSERT INTO "title_feedback"("id", "tmdbId", "mediaType", "status", "title", "year", "createdAt", "updatedAt", "userId") SELECT "id", "tmdbId", "mediaType", "status", "title", "year", "createdAt", "updatedAt", "userId" FROM "temporary_title_feedback"`
    );
    await queryRunner.query(`DROP TABLE "temporary_title_feedback"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_1f358d83723eb66d67a896d07a" ON "title_feedback" ("userId") `
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" RENAME TO "temporary_user_settings"`
    );
    await queryRunner.query(
      `CREATE TABLE "user_settings" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "locale" varchar NOT NULL DEFAULT (''), "discoverRegion" varchar, "streamingRegion" varchar, "originalLanguage" varchar, "pgpKey" varchar, "discordIds" text, "pushbulletAccessToken" varchar, "pushoverApplicationToken" varchar, "pushoverUserKey" varchar, "pushoverSound" varchar, "telegramChatId" varchar, "telegramSendSilently" boolean, "watchlistSyncMovies" boolean, "watchlistSyncTv" boolean, "notificationTypes" text, "userId" integer, "telegramMessageThreadId" varchar, CONSTRAINT "REL_986a2b6d3c05eb4091bb8066f7" UNIQUE ("userId"), CONSTRAINT "FK_986a2b6d3c05eb4091bb8066f78" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `INSERT INTO "user_settings"("id", "locale", "discoverRegion", "streamingRegion", "originalLanguage", "pgpKey", "discordIds", "pushbulletAccessToken", "pushoverApplicationToken", "pushoverUserKey", "pushoverSound", "telegramChatId", "telegramSendSilently", "watchlistSyncMovies", "watchlistSyncTv", "notificationTypes", "userId", "telegramMessageThreadId") SELECT "id", "locale", "discoverRegion", "streamingRegion", "originalLanguage", "pgpKey", "discordIds", "pushbulletAccessToken", "pushoverApplicationToken", "pushoverUserKey", "pushoverSound", "telegramChatId", "telegramSendSilently", "watchlistSyncMovies", "watchlistSyncTv", "notificationTypes", "userId", "telegramMessageThreadId" FROM "temporary_user_settings"`
    );
    await queryRunner.query(`DROP TABLE "temporary_user_settings"`);
    await queryRunner.query(`DROP INDEX "IDX_1f358d83723eb66d67a896d07a"`);
    await queryRunner.query(`DROP TABLE "title_feedback"`);
  }
}

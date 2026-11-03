import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAiSuggestion1793724510929 implements MigrationInterface {
  name = 'AddAiSuggestion1793724510929';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_suggestion" ("id" SERIAL NOT NULL, "tmdbId" integer NOT NULL, "mediaType" character varying NOT NULL, "title" character varying NOT NULL, "year" integer, "reason" character varying NOT NULL DEFAULT '', "outcome" character varying NOT NULL DEFAULT 'pending', "timesShown" integer NOT NULL DEFAULT '1', "firstShownAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lastShownAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "resolvedAt" TIMESTAMP WITH TIME ZONE, "userId" integer, CONSTRAINT "UNIQUE_AI_SUGGESTION" UNIQUE ("userId", "tmdbId", "mediaType"), CONSTRAINT "PK_8c6eea3a4947e6a315113c396c3" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d546acbf4cc65976a2792f3705" ON "ai_suggestion" ("userId") `
    );
    await queryRunner.query(
      `ALTER TABLE "ai_suggestion" ADD CONSTRAINT "FK_d546acbf4cc65976a2792f37050" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_suggestion" DROP CONSTRAINT "FK_d546acbf4cc65976a2792f37050"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_d546acbf4cc65976a2792f3705"`
    );
    await queryRunner.query(`DROP TABLE "ai_suggestion"`);
  }
}

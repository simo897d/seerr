import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAiFeedback1793475497966 implements MigrationInterface {
  name = 'AddAiFeedback1793475497966';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "title_feedback" ("id" SERIAL NOT NULL, "tmdbId" integer NOT NULL, "mediaType" character varying NOT NULL, "status" character varying NOT NULL, "title" character varying NOT NULL, "year" integer, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "userId" integer, CONSTRAINT "UNIQUE_TITLE_FEEDBACK" UNIQUE ("userId", "tmdbId", "mediaType"), CONSTRAINT "PK_fef0678b88c9007541017860779" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1f358d83723eb66d67a896d07a" ON "title_feedback" ("userId") `
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "aiKidsMode" boolean NOT NULL DEFAULT false`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" ADD "aiExcludedLibraries" text`
    );
    await queryRunner.query(
      `ALTER TABLE "title_feedback" ADD CONSTRAINT "FK_1f358d83723eb66d67a896d07a2" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "title_feedback" DROP CONSTRAINT "FK_1f358d83723eb66d67a896d07a2"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "aiExcludedLibraries"`
    );
    await queryRunner.query(
      `ALTER TABLE "user_settings" DROP COLUMN "aiKidsMode"`
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1f358d83723eb66d67a896d07a"`
    );
    await queryRunner.query(`DROP TABLE "title_feedback"`);
  }
}

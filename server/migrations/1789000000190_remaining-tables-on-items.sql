-- Season and episode ids are the group and item ids, so the columns are renamed in place.
ALTER TABLE "likes" RENAME COLUMN "seasonId" TO "groupId";
ALTER TABLE "likes" RENAME COLUMN "episodeId" TO "itemId";
ALTER TABLE "likes" RENAME CONSTRAINT "FK_8b1354ded3e5cd533bc0d04ce18" TO "FK_likes_group";
ALTER TABLE "likes" RENAME CONSTRAINT "FK_67214b2270f001c5a96a3626315" TO "FK_likes_item";
ALTER INDEX "IDX_likes_seasonId" RENAME TO "IDX_likes_groupId";
ALTER INDEX "IDX_likes_episodeId" RENAME TO "IDX_likes_itemId";
ALTER INDEX "UQ_likes_movie" RENAME TO "UQ_likes_media";
ALTER INDEX "UQ_likes_season" RENAME TO "UQ_likes_group";
ALTER INDEX "UQ_likes_episode" RENAME TO "UQ_likes_item";

ALTER TABLE "content_recommendations" RENAME COLUMN "seasonId" TO "groupId";
ALTER TABLE "content_recommendations" RENAME COLUMN "episodeId" TO "itemId";
ALTER TABLE "content_recommendations" RENAME CONSTRAINT "FK_1a6417072770a4914bd315ab750" TO "FK_content_recommendations_group";
ALTER TABLE "content_recommendations" RENAME CONSTRAINT "FK_461751303606d68d0c5666347d7" TO "FK_content_recommendations_item";
ALTER INDEX "IDX_content_recommendations_seasonId" RENAME TO "IDX_content_recommendations_groupId";
ALTER INDEX "IDX_content_recommendations_episodeId" RENAME TO "IDX_content_recommendations_itemId";

ALTER TABLE "cleanup_candidates" RENAME COLUMN "seasonId" TO "groupId";
ALTER TABLE "cleanup_candidates" RENAME COLUMN "episodeId" TO "itemId";
ALTER TABLE "cleanup_candidates" RENAME CONSTRAINT "cleanup_candidates_seasonId_fkey" TO "FK_cleanup_candidates_group";
ALTER TABLE "cleanup_candidates" RENAME CONSTRAINT "cleanup_candidates_episodeId_fkey" TO "FK_cleanup_candidates_item";
ALTER INDEX "IDX_cleanup_candidates_seasonId" RENAME TO "IDX_cleanup_candidates_groupId";
ALTER INDEX "IDX_cleanup_candidates_episodeId" RENAME TO "IDX_cleanup_candidates_itemId";

ALTER TABLE "cleanup_exclusions" RENAME COLUMN "seasonId" TO "groupId";
ALTER TABLE "cleanup_exclusions" RENAME COLUMN "episodeId" TO "itemId";
ALTER TABLE "cleanup_exclusions" RENAME CONSTRAINT "cleanup_exclusions_seasonId_fkey" TO "FK_cleanup_exclusions_group";
ALTER TABLE "cleanup_exclusions" RENAME CONSTRAINT "cleanup_exclusions_episodeId_fkey" TO "FK_cleanup_exclusions_item";
ALTER INDEX "IDX_cleanup_exclusions_seasonId" RENAME TO "IDX_cleanup_exclusions_groupId";
ALTER INDEX "IDX_cleanup_exclusions_episodeId" RENAME TO "IDX_cleanup_exclusions_itemId";

ALTER TABLE "subtitle_files" RENAME COLUMN "episodeId" TO "itemId";
ALTER TABLE "subtitle_files" RENAME CONSTRAINT "FK_9fd8637cb821ddec6f57b422785" TO "FK_subtitle_files_item";
ALTER INDEX "IDX_subtitle_files_episodeId" RENAME TO "IDX_subtitle_files_itemId";

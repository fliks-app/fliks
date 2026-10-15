
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT * FROM (VALUES
        ('media', 'FK_media_addedById_users', 'FK_724fe2622945e05c195981e5093'),
        ('subtitle_files', 'FK_subtitle_files_translation_provider', 'FK_295bae34d5648dd18b16747db4a'),
        ('user_follows', 'FK_user_follows_follower', 'FK_6300484b604263eaae8a6aab88d'),
        ('user_follows', 'FK_user_follows_following', 'FK_7c6c27f12c4e972eab4b3aaccbf'),
        ('likes', 'FK_likes_user', 'FK_cfd8e81fac09d7339a32e57d904'),
        ('likes', 'FK_likes_media', 'FK_65ef9a90fa855c14dd0cd896c8b'),
        ('likes', 'FK_likes_season', 'FK_8b1354ded3e5cd533bc0d04ce18'),
        ('likes', 'FK_likes_episode', 'FK_67214b2270f001c5a96a3626315'),
        ('content_recommendations', 'FK_content_recommendations_sender', 'FK_a28f439c529ee2c6540d329e544'),
        ('content_recommendations', 'FK_content_recommendations_recipient', 'FK_ee17496f10af9bad93ad1b94f2d'),
        ('content_recommendations', 'FK_content_recommendations_media', 'FK_2e975a73e827bc421da61575b7a'),
        ('content_recommendations', 'FK_content_recommendations_season', 'FK_1a6417072770a4914bd315ab750'),
        ('content_recommendations', 'FK_content_recommendations_episode', 'FK_461751303606d68d0c5666347d7'),
        ('playlist_items', 'FK_playlist_items_playlist', 'FK_1a5c30e99b5283b5653ee29b6b5'),
        ('playlist_items', 'FK_playlist_items_media', 'FK_16f8c7b6e4824b9ccca31b9616b'),
        ('playlist_items', 'FK_playlist_items_episode', 'FK_9dcd364d418c539e74b7f57ad36'),
        ('playlist_items', 'FK_playlist_items_addedBy', 'FK_0f9dbadfd3458af1e6bc49c93e3'),
        ('playlists', 'FK_playlists_owner', 'FK_aa5d498a2f045be2fb71ef98d45'),
        ('playlist_shares', 'FK_playlist_shares_playlist', 'FK_5d4f9a22dd268ce08eb2319d0c8'),
        ('playlist_shares', 'FK_playlist_shares_user', 'FK_62c91d23418a7ae8115f07f64d9'),
        ('playlist_saves', 'FK_playlist_saves_user', 'FK_fe0902ebcd7a31e03080d4bf4af'),
        ('playlist_saves', 'FK_playlist_saves_playlist', 'FK_957d1f3537c85497076254ac1e8'),
        ('refresh_tokens', 'FK_refresh_tokens_user', 'FK_610102b60fea1455310ccd299de')
        ) AS t(tbl, from_name, to_name)
        LOOP
          IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = r.from_name AND conrelid = r.tbl::regclass
          ) THEN
            EXECUTE format(
              'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
              r.tbl, r.from_name, r.to_name
            );
          END IF;
        END LOOP;
      END $$;

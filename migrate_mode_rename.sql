-- Rename mode values from old naming to new naming

-- memories
UPDATE memories SET mode = 'after_dark' WHERE mode = 'NSFW';
UPDATE memories SET mode = 'sfw' WHERE mode = 'SFW';

-- session_summaries
UPDATE session_summaries SET mode = 'after_dark' WHERE mode = 'NSFW';
UPDATE session_summaries SET mode = 'sfw' WHERE mode = 'SFW';

-- user_activity
UPDATE user_activity SET mode = 'after_dark' WHERE mode = 'NSFW';
UPDATE user_activity SET mode = 'sfw' WHERE mode = 'SFW';

-- re_engagement_messages
UPDATE re_engagement_messages SET mode = 'after_dark' WHERE mode = 'NSFW';
UPDATE re_engagement_messages SET mode = 'sfw' WHERE mode = 'SFW';

-- chat_runs
UPDATE chat_runs SET mode = 'after_dark' WHERE mode = 'NSFW';
UPDATE chat_runs SET mode = 'sfw' WHERE mode = 'SFW';

-- Verify
SELECT 'memories' AS tbl, mode, COUNT(*) FROM memories GROUP BY mode
UNION ALL
SELECT 'session_summaries', mode, COUNT(*) FROM session_summaries GROUP BY mode
UNION ALL
SELECT 'user_activity', mode, COUNT(*) FROM user_activity GROUP BY mode
UNION ALL
SELECT 'chat_runs', mode, COUNT(*) FROM chat_runs GROUP BY mode;

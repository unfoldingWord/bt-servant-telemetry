-- Languages per turn.
--
-- input_language is the ISO 639-1 code of the language the user wrote the
-- message in, detected by the engine (bt-servant-worker #404) and carried on
-- chat_turn; "und" when it could not tell. response_language is only the
-- stored reply preference ("en" for nearly everyone), so until now nothing
-- recorded the language people actually write in.
--
-- target_language is the language the user is translating the Bible INTO, as
-- the ingest scrubber (ingest/scrub.ts) inferred it from the exchange: an
-- English language name, or NULL when the conversation does not make it
-- explicit. Never the language they wrote in — translators work in a wider
-- language such as English, French or Indonesian while translating into another.

ALTER TABLE events ADD COLUMN input_language TEXT;   -- e.g. "sw", "und"
ALTER TABLE events ADD COLUMN target_language TEXT;  -- e.g. "Tetun"

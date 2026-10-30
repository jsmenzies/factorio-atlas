-- The admin's account list (/admin/accounts, lib/server/admin/accounts.ts) shows accounts newest first, a
-- page at a time: walking this index reads one page's rows instead of sorting the whole table.
CREATE INDEX users_created ON users (created_at);

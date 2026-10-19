-- What a print makes and takes, as "item:<name>" / "fluid:<name>" signal ids.
-- output: from blueprint icons. input: from sign combinators, minus outputs.
-- Recipe-derived products join this once prototype data is loaded.
CREATE TABLE print_items (
	print_id TEXT NOT NULL REFERENCES prints (id) ON DELETE CASCADE,
	item TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('output', 'input')),
	PRIMARY KEY (print_id, item, role)
);
CREATE INDEX print_items_item ON print_items (item, role);

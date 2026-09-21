/**
 * @jest-environment node
 */
// `docker compose up` never worked: the app container reached its own database
// at `db:5432`, and the SSL rule only knew "localhost means no SSL". So the app
// asked the postgres image for SSL, the image has none, and every page that
// read the metadata DB failed with "The server does not support SSL
// connections". The compose URL now says `sslmode=disable`, and this rule
// honours it. The last test reads docker-compose.yml itself, so the fix cannot
// be half undone from the other side.
import fs from "fs";
import path from "path";
import { metadataWantsSsl } from "@/lib/db/metadata-ssl";

describe("metadataWantsSsl", () => {
  it("turns SSL off when the URL says sslmode=disable, whatever the host", () => {
    expect(metadataWantsSsl("postgres://studio:studio@db:5432/studio?sslmode=disable")).toBe(false);
  });

  it("turns SSL off for this machine, as npm run dev needs", () => {
    expect(metadataWantsSsl("postgres://studio:studio@localhost:5433/studio")).toBe(false);
    expect(metadataWantsSsl("postgres://studio:studio@127.0.0.1:5433/studio")).toBe(false);
  });

  it("keeps SSL on for any other host, which is how hosted Postgres is reached", () => {
    expect(metadataWantsSsl("postgres://u:p@db:5432/studio")).toBe(true);
    expect(metadataWantsSsl("postgres://u:p@ep-cool-name.neon.tech/app?sslmode=require")).toBe(true);
  });

  it("is what docker-compose.yml's own DATABASE_URL_A asks for", () => {
    const compose = fs.readFileSync(path.join(__dirname, "..", "..", "docker-compose.yml"), "utf8");
    const line = compose.split("\n").find((l) => l.trim().startsWith("DATABASE_URL_A:"));
    expect(line).toBeDefined();
    // The ${...:-default} parts are compose syntax; fill them the way compose
    // would with nothing set, then ask the rule.
    const url = line!.split("DATABASE_URL_A:")[1].trim().replace(/\$\{[A-Z_]+:-([^}]*)\}/g, "$1");
    expect(url).toContain("@db:5432/");
    expect(metadataWantsSsl(url)).toBe(false);
  });
});

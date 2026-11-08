/**
 * Which connections stay on this computer without the website being asked
 * (src/core/stays-home.ts). A home address never goes up, not even for a test,
 * and anything unreadable stays home too.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isHomeHost, staysHome } from "../core/stays-home";

test("addresses that only mean something here stay home", () => {
  for (const host of [
    "",
    "  ",
    "localhost",
    "LOCALHOST.",
    "db.localhost",
    "printer.local",
    "pg.internal",
    "nas.lan",
    "box.home.arpa",
    "mydb",
    "/var/run/postgresql",
    "@abstract",
    "127.0.0.1",
    "127.8.9.10",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "100.64.0.1",
    "100.127.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "[::1]",
    "::",
    "fd12:3456::1",
    "fc00::1",
    "fe80::1",
    "::ffff:192.168.1.1",
    "::ffff:7f00:1",
    "1.2.3",
    "db.example.com,localhost",
  ]) {
    assert.equal(isHomeHost(host), true, host);
  }
});

test("public addresses go to the website to decide", () => {
  for (const host of [
    "db.example.com",
    "ep-made-up-123.ap-southeast-2.aws.neon.tech",
    "aws-0-ap-southeast-2.pooler.supabase.com",
    "8.8.8.8",
    "172.32.0.1",
    "172.15.0.1",
    "100.128.0.1",
    "192.169.1.1",
    "2001:db8::1",
    "::ffff:8.8.8.8",
    "db.example.com,db2.example.com",
  ]) {
    assert.equal(isHomeHost(host), false, host);
  }
});

test("a connection string's address wins over the host field", () => {
  assert.equal(staysHome({ host: "db.example.com", connection_string: "postgres://u@localhost:5432/app" }), true);
  assert.equal(staysHome({ host: "localhost", connection_string: "postgresql://u@db.example.com/app" }), false);
  assert.equal(staysHome({ connection_string: "postgres://u@db.example.com/app?host=/tmp" }), true);
  assert.equal(staysHome({ connection_string: "postgres://u@[::1]:5432/app" }), true);
  assert.equal(staysHome({ connection_string: "postgres:///app" }), true);
  assert.equal(staysHome({ host: "db.example.com", connection_string: "   " }), false);
});

test("anything it cannot read stays home", () => {
  assert.equal(staysHome({}), true);
  assert.equal(staysHome({ host: 5432 }), true);
  assert.equal(staysHome({ connection_string: "not a url" }), true);
  assert.equal(staysHome({ connection_string: "mysql://u@db.example.com/app" }), true);
});

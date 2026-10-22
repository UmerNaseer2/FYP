/**
 * The pure half of "Find databases on this computer" (src/core/finder.ts).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PROBE_PORTS,
  SSL_REQUEST,
  dockerFindings,
  isOfficialPostgresImage,
  isPostgresReply,
  mergeFindings,
  parseDockerInspect,
  portFinding,
  type DockerContainer,
} from "../core/finder";

// Made up, and built here so the repository holds no password-shaped text.
const PASSWORD = "typed-for-" + "another-server";

test("knocks on PostgreSQL's port and the seven after it", () => {
  assert.deepEqual(PROBE_PORTS, [5432, 5433, 5434, 5435, 5436, 5437, 5438, 5439]);
});

test("the knock is PostgreSQL's SSLRequest: length 8, then the code 80877103", () => {
  assert.equal(SSL_REQUEST.length, 8);
  assert.equal(SSL_REQUEST.readUInt32BE(0), 8);
  assert.equal(SSL_REQUEST.readUInt32BE(4), 80877103);
});

test("only a single S or N counts as PostgreSQL's answer", () => {
  assert.equal(isPostgresReply(Buffer.from("S")), true);
  assert.equal(isPostgresReply(Buffer.from("N")), true);
  assert.equal(isPostgresReply(Buffer.from("E")), false);
  assert.equal(isPostgresReply(Buffer.alloc(0)), false);
  assert.equal(isPostgresReply(Buffer.from("SN")), false);
});

const INSPECT = JSON.stringify([
  {
    Name: "/shop-db",
    Config: {
      Image: "postgres:17-alpine",
      Env: ["POSTGRES_USER=shop", "POSTGRES_DB=shop_dev", "POSTGRES_PASSWORD=" + PASSWORD, "=weird", "PATH=/usr/bin"],
    },
    NetworkSettings: {
      Ports: {
        "5432/tcp": [
          { HostIp: "0.0.0.0", HostPort: "5433" },
          { HostIp: "::", HostPort: "5433" },
        ],
      },
    },
  },
  { Name: "/no-ports", Config: { Image: "postgres:16", Env: [] }, NetworkSettings: { Ports: { "5432/tcp": null } } },
  {
    Name: "/bad-ports",
    Config: { Image: "postgres:16" },
    NetworkSettings: {
      Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }, { HostPort: "abc" }, { HostPort: "70000" }] },
    },
  },
  { Config: { Image: "postgres" }, NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "", HostPort: "5440" }] } } },
  null,
  "text",
]);

test("reads only the containers that publish PostgreSQL's port, and never the password", () => {
  const containers = parseDockerInspect(INSPECT);
  assert.deepEqual(containers, [
    {
      name: "shop-db",
      image: "postgres:17-alpine",
      env: { POSTGRES_USER: "shop", POSTGRES_DB: "shop_dev" },
      published: [
        { hostIp: "0.0.0.0", hostPort: 5433 },
        { hostIp: "::", hostPort: 5433 },
      ],
    },
  ]);
  assert.equal(JSON.stringify(containers).includes(PASSWORD), false);
});

test("anything from Docker that is not a list of containers gives nothing", () => {
  assert.deepEqual(parseDockerInspect("not json"), []);
  assert.deepEqual(parseDockerInspect('{"Name":"/one"}'), []);
  assert.deepEqual(parseDockerInspect(""), []);
});

function container(changes: Partial<DockerContainer>): DockerContainer {
  return { name: "db", image: "postgres:17", env: {}, published: [{ hostIp: "0.0.0.0", hostPort: 5434 }], ...changes };
}

test("a container becomes one entry per address, filled in from its settings", () => {
  assert.deepEqual(dockerFindings(parseDockerInspect(INSPECT)), [
    {
      source: "docker",
      label: "Docker: shop-db (postgres:17-alpine)",
      host: "127.0.0.1",
      port: 5433,
      user: "shop",
      database: "shop_dev",
      container: "shop-db",
    },
  ]);
});

test("the official image's defaults fill in a user and database that were not set", () => {
  const [plain] = dockerFindings([container({})]);
  assert.equal(plain.user, "postgres");
  assert.equal(plain.database, "postgres");

  const [onlyUser] = dockerFindings([container({ env: { POSTGRES_USER: "app" } })]);
  assert.equal(onlyUser.user, "app");
  assert.equal(onlyUser.database, "app");
});

test("another image's defaults are not guessed at", () => {
  const [onlyUser] = dockerFindings([container({ image: "bitnami/postgresql:17", env: { POSTGRES_USER: "app" } })]);
  assert.equal(onlyUser.user, "app");
  assert.equal(onlyUser.database, null);

  const [nothing] = dockerFindings([container({ image: "bitnami/postgresql:17" })]);
  assert.equal(nothing.user, null);
  assert.equal(nothing.database, null);
});

test("a port published on one particular address keeps that address", () => {
  const [found] = dockerFindings([container({ published: [{ hostIp: "192.168.1.5", hostPort: 5434 }] })]);
  assert.equal(found.host, "192.168.1.5");
});

test("a container with no image name is labeled by its name alone", () => {
  const [found] = dockerFindings([container({ image: "" })]);
  assert.equal(found.label, "Docker: db");
});

test("recognizes the official PostgreSQL image however it is written, and nothing else", () => {
  for (const image of [
    "postgres",
    "postgres:17-alpine",
    "postgres:17@sha256:0123abcd",
    "library/postgres",
    "docker.io/library/postgres:16",
    "index.docker.io/library/postgres",
    "registry-1.docker.io/library/postgres:17",
    "postgis/postgis:17-3.5",
    "docker.io/postgis/postgis",
  ]) {
    assert.equal(isOfficialPostgresImage(image), true, image);
  }
  for (const image of [
    "",
    "bitnami/postgresql",
    "postgres-custom",
    "mypostgres",
    "myregistry:5000/postgres",
    "ghcr.io/someone/postgres",
    "timescale/timescaledb",
  ]) {
    assert.equal(isOfficialPostgresImage(image), false, image);
  }
});

test("a port that answered the knock is an entry with nothing filled in", () => {
  assert.deepEqual(portFinding(5432), {
    source: "port",
    label: "PostgreSQL on port 5432",
    host: "127.0.0.1",
    port: 5432,
    user: null,
    database: null,
  });
});

test("Docker's entry replaces the knock's for the same port, and the list is sorted by port", () => {
  const shop = dockerFindings(parseDockerInspect(INSPECT))[0];
  const remote = dockerFindings([
    container({ name: "remote", published: [{ hostIp: "192.168.1.5", hostPort: 5432 }] }),
  ])[0];
  assert.deepEqual(mergeFindings([portFinding(5433), portFinding(5432)], [shop, remote]), [
    remote,
    portFinding(5432),
    shop,
  ]);
});

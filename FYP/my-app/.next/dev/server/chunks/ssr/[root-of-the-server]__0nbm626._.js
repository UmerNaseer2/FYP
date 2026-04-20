module.exports = [
"[externals]/next/dist/shared/lib/no-fallback-error.external.js [external] (next/dist/shared/lib/no-fallback-error.external.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/shared/lib/no-fallback-error.external.js", () => require("next/dist/shared/lib/no-fallback-error.external.js"));

module.exports = mod;
}),
"[project]/app/favicon.ico (static in ecmascript, tag client)", ((__turbopack_context__) => {

__turbopack_context__.v("/_next/static/media/favicon.0x3dzn~oxb6tn.ico" + (globalThis["NEXT_CLIENT_ASSET_SUFFIX"] || ''));}),
"[project]/app/favicon.ico.mjs { IMAGE => \"[project]/app/favicon.ico (static in ecmascript, tag client)\" } [app-rsc] (structured image object, ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>__TURBOPACK__default__export__
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$favicon$2e$ico__$28$static__in__ecmascript$2c$__tag__client$29$__ = __turbopack_context__.i("[project]/app/favicon.ico (static in ecmascript, tag client)");
;
const __TURBOPACK__default__export__ = {
    src: __TURBOPACK__imported__module__$5b$project$5d2f$app$2f$favicon$2e$ico__$28$static__in__ecmascript$2c$__tag__client$29$__["default"],
    width: 256,
    height: 256
};
}),
"[project]/components/Sidebar.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>Sidebar
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/client/app-dir/link.react-server.js [app-rsc] (ecmascript)");
;
;
function Sidebar({ current }) {
    const links = [
        {
            name: "Dashboard",
            href: "/"
        },
        {
            name: "Connections",
            href: "/connections"
        },
        {
            name: "Schema Comparison",
            href: "/compare"
        },
        {
            name: "Version Detection",
            href: "/versions"
        },
        {
            name: "SQL Scripts",
            href: "/scripts"
        }
    ];
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("aside", {
        className: "db-sidebar",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "db-sidebar__header",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "db-sidebar__title",
                        children: "DB Schema Control"
                    }, void 0, false, {
                        fileName: "[project]/components/Sidebar.tsx",
                        lineNumber: 15,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "db-sidebar__subtitle",
                        children: "Schema comparison demo"
                    }, void 0, false, {
                        fileName: "[project]/components/Sidebar.tsx",
                        lineNumber: 16,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/components/Sidebar.tsx",
                lineNumber: 14,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("nav", {
                className: "db-sidebar__nav",
                children: links.map((link)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$client$2f$app$2d$dir$2f$link$2e$react$2d$server$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"], {
                        href: link.href,
                        className: `db-sidebar__link ${current === link.name ? "db-sidebar__link--active" : ""}`,
                        children: link.name
                    }, link.name, false, {
                        fileName: "[project]/components/Sidebar.tsx",
                        lineNumber: 21,
                        columnNumber: 11
                    }, this))
            }, void 0, false, {
                fileName: "[project]/components/Sidebar.tsx",
                lineNumber: 19,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "db-sidebar__footer",
                children: "v1.0.0"
            }, void 0, false, {
                fileName: "[project]/components/Sidebar.tsx",
                lineNumber: 33,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/components/Sidebar.tsx",
        lineNumber: 13,
        columnNumber: 5
    }, this);
}
}),
"[project]/components/Topbar.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "default",
    ()=>Topbar
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
;
function Topbar({ title, text }) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "db-topbar",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h1", {
                        className: "db-topbar__title",
                        children: title
                    }, void 0, false, {
                        fileName: "[project]/components/Topbar.tsx",
                        lineNumber: 5,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                        className: "db-topbar__text",
                        children: text
                    }, void 0, false, {
                        fileName: "[project]/components/Topbar.tsx",
                        lineNumber: 6,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/components/Topbar.tsx",
                lineNumber: 4,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "db-topbar__user",
                children: "Admin"
            }, void 0, false, {
                fileName: "[project]/components/Topbar.tsx",
                lineNumber: 8,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/components/Topbar.tsx",
        lineNumber: 3,
        columnNumber: 5
    }, this);
}
}),
"[externals]/fs [external] (fs, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("fs", () => require("fs"));

module.exports = mod;
}),
"[project]/lib/postgres.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

__turbopack_context__.s([
    "fetchSchemaNames",
    ()=>fetchSchemaNames,
    "fetchSchemaSnapshot",
    ()=>fetchSchemaSnapshot,
    "resolveCompareTargets",
    ()=>resolveCompareTargets
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$pg$2d$connection$2d$string$2f$esm$2f$index$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/pg-connection-string/esm/index.mjs [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$pg__$5b$external$5d$__$28$pg$2c$__esm_import$2c$__$5b$project$5d2f$node_modules$2f$pg$29$__ = __turbopack_context__.i("[externals]/pg [external] (pg, esm_import, [project]/node_modules/pg)");
var __turbopack_async_dependencies__ = __turbopack_handle_async_dependencies__([
    __TURBOPACK__imported__module__$5b$externals$5d2f$pg__$5b$external$5d$__$28$pg$2c$__esm_import$2c$__$5b$project$5d2f$node_modules$2f$pg$29$__
]);
[__TURBOPACK__imported__module__$5b$externals$5d2f$pg__$5b$external$5d$__$28$pg$2c$__esm_import$2c$__$5b$project$5d2f$node_modules$2f$pg$29$__] = __turbopack_async_dependencies__.then ? (await __turbopack_async_dependencies__)() : __turbopack_async_dependencies__;
;
;
function poolMap() {
    if (!globalThis.__comparePgPoolMap) {
        globalThis.__comparePgPoolMap = new Map();
    }
    return globalThis.__comparePgPoolMap;
}
function poolKey(cfg) {
    return [
        cfg.host ?? "",
        String(cfg.port ?? ""),
        cfg.database ?? "",
        cfg.user ?? "",
        cfg.password ?? ""
    ].join("\0");
}
function getPoolForConfig(cfg) {
    const key = poolKey(cfg);
    const map = poolMap();
    let p = map.get(key);
    if (!p) {
        p = new __TURBOPACK__imported__module__$5b$externals$5d2f$pg__$5b$external$5d$__$28$pg$2c$__esm_import$2c$__$5b$project$5d2f$node_modules$2f$pg$29$__["Pool"]({
            ...cfg,
            max: 4
        });
        map.set(key, p);
    }
    return p;
}
function normalizeDefinition(value) {
    return value.replace(/\s+/g, " ").trim();
}
function coerceTextArray(value) {
    if (Array.isArray(value)) {
        return value.map((entry)=>String(entry).trim()).filter((entry)=>entry.length > 0);
    }
    if (typeof value !== "string") {
        return [];
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === "{}") {
        return [];
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        const inner = trimmed.slice(1, -1).trim();
        if (inner.length === 0) {
            return [];
        }
        return inner.split(",").map((entry)=>entry.replace(/^"(.*)"$/, "$1").trim()).filter((entry)=>entry.length > 0);
    }
    return [
        trimmed
    ];
}
function formatAction(code) {
    switch(code){
        case "a":
            return "NO ACTION";
        case "r":
            return "RESTRICT";
        case "c":
            return "CASCADE";
        case "n":
            return "SET NULL";
        case "d":
            return "SET DEFAULT";
        default:
            return "UNKNOWN";
    }
}
function trimEnv(name) {
    const v = process.env[name]?.trim();
    return v && v.length > 0 ? v : undefined;
}
function resolveCompareTargets() {
    const urlA = trimEnv("DATABASE_URL_A") || trimEnv("DATABASE_URL");
    const urlB = trimEnv("DATABASE_URL_B");
    if (!urlA) {
        return {
            ok: false,
            error: "Set DATABASE_URL in .env.local (or DATABASE_URL_A + DATABASE_URL_B for two full URLs)."
        };
    }
    try {
        if (urlB) {
            const cfgA = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$pg$2d$connection$2d$string$2f$esm$2f$index$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["parseIntoClientConfig"])(urlA);
            const cfgB = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$pg$2d$connection$2d$string$2f$esm$2f$index$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["parseIntoClientConfig"])(urlB);
            return {
                ok: true,
                a: {
                    id: "a",
                    config: cfgA,
                    displayName: cfgA.database ?? "database A"
                },
                b: {
                    id: "b",
                    config: cfgB,
                    displayName: cfgB.database ?? "database B"
                }
            };
        }
        const base = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$pg$2d$connection$2d$string$2f$esm$2f$index$2e$mjs__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["parseIntoClientConfig"])(urlA);
        const dbA = trimEnv("COMPARE_DATABASE_A") || "postgres";
        const dbB = trimEnv("COMPARE_DATABASE_B") || "TEST";
        const cfgA = {
            ...base,
            database: dbA
        };
        const cfgB = {
            ...base,
            database: dbB
        };
        return {
            ok: true,
            a: {
                id: "a",
                config: cfgA,
                displayName: dbA
            },
            b: {
                id: "b",
                config: cfgB,
                displayName: dbB
            }
        };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            error: `Invalid connection URL: ${message}`
        };
    }
}
async function fetchSchemaNames(cfg) {
    const pool = getPoolForConfig(cfg);
    try {
        const result = await pool.query(`SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name <> 'information_schema'
         AND schema_name NOT LIKE 'pg_%'
       ORDER BY schema_name`);
        return {
            ok: true,
            data: result.rows.map((row)=>row.schema_name)
        };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            error: message
        };
    }
}
async function fetchSchemaSnapshot(cfg, schemaName) {
    const pool = getPoolForConfig(cfg);
    const database = cfg.database ?? "(unknown)";
    try {
        const [tableResult, columnResult, constraintResult] = await Promise.all([
            pool.query(`SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = $1
           AND table_type = 'BASE TABLE'
         ORDER BY table_name`, [
                schemaName
            ]),
            pool.query(`SELECT
           c.table_name,
           c.column_name,
           c.ordinal_position,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS type_display,
           (c.is_nullable = 'YES') AS is_nullable
         FROM information_schema.columns c
         JOIN pg_namespace n
           ON n.nspname = c.table_schema
         JOIN pg_class cls
           ON cls.relnamespace = n.oid
          AND cls.relname = c.table_name
          AND cls.relkind = 'r'
         JOIN pg_attribute a
           ON a.attrelid = cls.oid
          AND a.attname = c.column_name
          AND a.attnum > 0
          AND NOT a.attisdropped
         WHERE c.table_schema = $1
         ORDER BY c.table_name, c.ordinal_position`, [
                schemaName
            ]),
            pool.query(`SELECT
           tbl.relname AS table_name,
           con.conname AS constraint_name,
           con.contype,
           pg_get_constraintdef(con.oid, true) AS definition,
           COALESCE(
             array_agg(att.attname ORDER BY key_cols.ordinality)
             FILTER (WHERE att.attname IS NOT NULL),
             ARRAY[]::text[]
           ) AS columns,
           ref_ns.nspname AS referenced_schema,
           ref_tbl.relname AS referenced_table,
           COALESCE(
             array_agg(ref_att.attname ORDER BY ref_cols.ordinality)
             FILTER (WHERE ref_att.attname IS NOT NULL),
             ARRAY[]::text[]
           ) AS referenced_columns,
           con.confupdtype,
           con.confdeltype
         FROM pg_constraint con
         JOIN pg_class tbl
           ON tbl.oid = con.conrelid
         JOIN pg_namespace ns
           ON ns.oid = tbl.relnamespace
         LEFT JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_cols(attnum, ordinality)
           ON true
         LEFT JOIN pg_attribute att
           ON att.attrelid = tbl.oid
          AND att.attnum = key_cols.attnum
         LEFT JOIN pg_class ref_tbl
           ON ref_tbl.oid = con.confrelid
         LEFT JOIN pg_namespace ref_ns
           ON ref_ns.oid = ref_tbl.relnamespace
         LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS ref_cols(attnum, ordinality)
           ON ref_cols.ordinality = key_cols.ordinality
         LEFT JOIN pg_attribute ref_att
           ON ref_att.attrelid = ref_tbl.oid
          AND ref_att.attnum = ref_cols.attnum
         WHERE ns.nspname = $1
           AND con.contype IN ('p', 'u', 'f', 'c', 'x')
         GROUP BY
           tbl.relname,
           con.conname,
           con.contype,
           con.oid,
           ref_ns.nspname,
           ref_tbl.relname,
           con.confupdtype,
           con.confdeltype
         ORDER BY tbl.relname, con.contype, con.conname`, [
                schemaName
            ])
        ]);
        const tablesByName = new Map();
        for (const row of tableResult.rows){
            tablesByName.set(row.table_name, {
                name: row.table_name,
                columns: [],
                primaryKey: null,
                uniqueConstraints: [],
                foreignKeys: [],
                checkConstraints: [],
                excludeConstraints: []
            });
        }
        for (const row of columnResult.rows){
            const table = tablesByName.get(row.table_name);
            if (!table) {
                continue;
            }
            table.columns.push({
                name: row.column_name,
                ordinalPosition: row.ordinal_position,
                typeDisplay: row.type_display,
                nullable: row.is_nullable,
                isPrimaryKey: false,
                uniqueConstraintNames: [],
                foreignKeyConstraintNames: []
            });
        }
        for (const row of constraintResult.rows){
            const table = tablesByName.get(row.table_name);
            if (!table) {
                continue;
            }
            const columns = coerceTextArray(row.columns);
            const definition = row.definition;
            const normalizedDefinition = normalizeDefinition(definition);
            if (row.contype === "p") {
                table.primaryKey = {
                    name: row.constraint_name,
                    kind: "PRIMARY KEY",
                    columns,
                    definition,
                    normalizedDefinition
                };
                for (const name of columns){
                    const column = table.columns.find((entry)=>entry.name === name);
                    if (column) {
                        column.isPrimaryKey = true;
                    }
                }
                continue;
            }
            if (row.contype === "u") {
                table.uniqueConstraints.push({
                    name: row.constraint_name,
                    kind: "UNIQUE",
                    columns,
                    definition,
                    normalizedDefinition
                });
                for (const name of columns){
                    const column = table.columns.find((entry)=>entry.name === name);
                    if (column) {
                        column.uniqueConstraintNames.push(row.constraint_name);
                    }
                }
                continue;
            }
            if (row.contype === "f") {
                const foreignKey = {
                    name: row.constraint_name,
                    kind: "FOREIGN KEY",
                    columns,
                    definition,
                    normalizedDefinition,
                    referencedSchema: row.referenced_schema,
                    referencedTable: row.referenced_table,
                    referencedColumns: coerceTextArray(row.referenced_columns),
                    onUpdate: formatAction(row.confupdtype),
                    onDelete: formatAction(row.confdeltype)
                };
                table.foreignKeys.push(foreignKey);
                for (const name of columns){
                    const column = table.columns.find((entry)=>entry.name === name);
                    if (column) {
                        column.foreignKeyConstraintNames.push(row.constraint_name);
                    }
                }
                continue;
            }
            const constraint = {
                name: row.constraint_name,
                kind: row.contype === "c" ? "CHECK" : "EXCLUDE",
                columns,
                definition,
                normalizedDefinition
            };
            if (row.contype === "c") {
                table.checkConstraints.push(constraint);
            } else {
                table.excludeConstraints.push(constraint);
            }
        }
        for (const table of tablesByName.values()){
            table.columns.sort((a, b)=>a.ordinalPosition - b.ordinalPosition);
            for (const column of table.columns){
                column.uniqueConstraintNames.sort();
                column.foreignKeyConstraintNames.sort();
            }
            table.uniqueConstraints.sort((a, b)=>a.name.localeCompare(b.name));
            table.foreignKeys.sort((a, b)=>a.name.localeCompare(b.name));
            table.checkConstraints.sort((a, b)=>a.name.localeCompare(b.name));
            table.excludeConstraints.sort((a, b)=>a.name.localeCompare(b.name));
        }
        return {
            ok: true,
            data: {
                database,
                schema: schemaName,
                tables: Array.from(tablesByName.values()).sort((a, b)=>a.name.localeCompare(b.name))
            }
        };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
            ok: false,
            error: message
        };
    }
}
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, false);}),
"[project]/lib/compare.ts [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "compareSchemas",
    ()=>compareSchemas,
    "describeConstraint",
    ()=>describeConstraint,
    "describeTableMatch",
    ()=>describeTableMatch,
    "extractBaseType",
    ()=>extractBaseType,
    "summarizeColumns",
    ()=>summarizeColumns,
    "typeChangeDescription",
    ()=>typeChangeDescription,
    "typeScore",
    ()=>typeScore
]);
const TABLE_MATCH_ACCEPT_THRESHOLD = 70;
const TABLE_MATCH_POSSIBLE_THRESHOLD = 55;
const COLUMN_MATCH_ACCEPT_THRESHOLD = 50;
const COLUMN_MATCH_POSSIBLE_THRESHOLD = 40;
function normalizeSimilarityText(value) {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
}
function normalizeIdentifier(value) {
    return value.trim();
}
function levenshtein(a, b) {
    if (a === b) {
        return 0;
    }
    if (a.length === 0) {
        return b.length;
    }
    if (b.length === 0) {
        return a.length;
    }
    const previous = Array.from({
        length: b.length + 1
    }, (_, index)=>index);
    for(let i = 0; i < a.length; i += 1){
        let diagonal = previous[0];
        previous[0] = i + 1;
        for(let j = 0; j < b.length; j += 1){
            const temp = previous[j + 1];
            const cost = a[i] === b[j] ? 0 : 1;
            previous[j + 1] = Math.min(previous[j + 1] + 1, previous[j] + 1, diagonal + cost);
            diagonal = temp;
        }
    }
    return previous[b.length];
}
function stringSimilarity(a, b) {
    const left = normalizeSimilarityText(a);
    const right = normalizeSimilarityText(b);
    if (left === right) {
        return 1;
    }
    const length = Math.max(left.length, right.length);
    if (length === 0) {
        return 1;
    }
    return Math.max(0, 1 - levenshtein(left, right) / length);
}
function roundScore(value) {
    return Math.round(value * 10) / 10;
}
function setSimilarity(left, right) {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    const union = new Set([
        ...leftSet,
        ...rightSet
    ]);
    if (union.size === 0) {
        return 1;
    }
    let intersection = 0;
    for (const value of leftSet){
        if (rightSet.has(value)) {
            intersection += 1;
        }
    }
    return intersection / union.size;
}
function normalizeType(typeDisplay) {
    return normalizeSimilarityText(typeDisplay);
}
function extractBaseType(typeDisplay) {
    const normalized = normalizeType(typeDisplay);
    const parenIndex = normalized.indexOf("(");
    if (parenIndex === -1) {
        return normalized;
    }
    return normalized.slice(0, parenIndex).trim();
}
function typeScore(leftTypeDisplay, rightTypeDisplay) {
    const leftNorm = normalizeType(leftTypeDisplay);
    const rightNorm = normalizeType(rightTypeDisplay);
    if (leftNorm === rightNorm) {
        return 20;
    }
    const leftBase = extractBaseType(leftNorm);
    const rightBase = extractBaseType(rightNorm);
    if (leftBase === rightBase) {
        return 12;
    }
    return 0;
}
function typeChangeDescription(leftTypeDisplay, rightTypeDisplay) {
    const leftBase = extractBaseType(leftTypeDisplay);
    const rightBase = extractBaseType(rightTypeDisplay);
    if (leftBase === rightBase) {
        return `Size/precision changed: ${leftTypeDisplay} → ${rightTypeDisplay}`;
    }
    return `Type changed: ${leftTypeDisplay} → ${rightTypeDisplay}`;
}
function matchDecision(score, acceptedThreshold) {
    return score >= acceptedThreshold ? "accepted" : "possible";
}
function columnsAsOrderedSignature(columns) {
    return columns.map((column)=>normalizeIdentifier(column)).join("|");
}
function columnsAsSetSignature(columns) {
    return [
        ...columns
    ].map((column)=>normalizeIdentifier(column)).sort().join("|");
}
function uniqueConstraintSignature(constraint) {
    return columnsAsSetSignature(constraint.columns);
}
function primaryKeySignature(constraint) {
    return constraint ? columnsAsOrderedSignature(constraint.columns) : "";
}
function foreignKeyLogicalSignature(foreignKey) {
    return [
        columnsAsOrderedSignature(foreignKey.columns),
        normalizeIdentifier(foreignKey.referencedSchema ?? ""),
        normalizeIdentifier(foreignKey.referencedTable ?? ""),
        columnsAsOrderedSignature(foreignKey.referencedColumns),
        normalizeIdentifier(foreignKey.onUpdate),
        normalizeIdentifier(foreignKey.onDelete)
    ].join("->");
}
function definitionSignature(constraint) {
    return constraint.normalizedDefinition;
}
function getColumnState(table, column) {
    return {
        nullable: column.nullable,
        primaryKey: column.isPrimaryKey,
        uniqueCount: column.uniqueConstraintNames.length,
        foreignKeyCount: column.foreignKeyConstraintNames.length
    };
}
function columnConstraintSimilarity(leftTable, leftColumn, rightTable, rightColumn) {
    const left = getColumnState(leftTable, leftColumn);
    const right = getColumnState(rightTable, rightColumn);
    let points = 0;
    if (left.nullable === right.nullable) {
        points += 5;
    }
    if (left.primaryKey === right.primaryKey) {
        points += 5;
    }
    if (Math.sign(left.uniqueCount) === Math.sign(right.uniqueCount)) {
        points += 2.5;
    }
    if (Math.sign(left.foreignKeyCount) === Math.sign(right.foreignKeyCount)) {
        points += 2.5;
    }
    return points / 15;
}
function columnOrderSimilarity(leftTable, leftColumn, rightTable, rightColumn) {
    // We compare where each column sits as a fraction of its table's total column count,
    // not the raw position number. This is the key improvement over the old approach.
    //
    // Old approach (absolute): if you insert a new column at position 2 in table B,
    // every column after it shifts by +1, so they ALL get penalised for "wrong position"
    // even though they didn't actually move relative to the rest of the table.
    //
    // New approach (relative): "email" as the last column in a 3-col table (ratio 1.0)
    // vs "email" as the last column in a 4-col table (ratio 1.0) → diff = 0, no penalty.
    //
    // Multiplying by 2 means: a shift of half the table's width scores 0.
    // Small shifts (neighbour columns) score close to 1.
    const leftRatio = leftColumn.ordinalPosition / Math.max(leftTable.columns.length, 1);
    const rightRatio = rightColumn.ordinalPosition / Math.max(rightTable.columns.length, 1);
    const diff = Math.abs(leftRatio - rightRatio);
    return Math.max(0, 1 - diff * 2);
}
function compareColumnPair(leftTable, leftColumn, rightTable, rightColumn) {
    // Column similarity is scored out of 60 total, split across four categories:
    //
    //   name:        0–15   how similar are the column names? (Levenshtein)
    //   type:        0–20   exact=20, same family different size=12, different=0
    //   constraints: 0–15   nullable, PK, unique, FK participation
    //   order:       0–10   relative position in the table (not the raw column number)
    //
    // Type is the heaviest single category (20) because changing a type is usually
    // a breaking database change. Order is the lightest (10) because column reordering
    // is usually cosmetic and should not drag down the overall match score.
    const name = stringSimilarity(leftColumn.name, rightColumn.name) * 15;
    const type = typeScore(leftColumn.typeDisplay, rightColumn.typeDisplay);
    const constraints = columnConstraintSimilarity(leftTable, leftColumn, rightTable, rightColumn) * 15;
    const order = columnOrderSimilarity(leftTable, leftColumn, rightTable, rightColumn) * 10;
    const changes = [];
    if (normalizeType(leftColumn.typeDisplay) !== normalizeType(rightColumn.typeDisplay)) {
        // typeChangeDescription tells us whether it's a real type change (integer → text)
        // or just a size/precision tweak (varchar(100) → varchar(200)).
        changes.push(typeChangeDescription(leftColumn.typeDisplay, rightColumn.typeDisplay));
    }
    if (leftColumn.nullable !== rightColumn.nullable) {
        changes.push(`Nullability changed from ${leftColumn.nullable ? "nullable" : "not null"} to ${rightColumn.nullable ? "nullable" : "not null"}`);
    }
    if (leftColumn.ordinalPosition !== rightColumn.ordinalPosition) {
        changes.push(`Order changed from #${leftColumn.ordinalPosition} to #${rightColumn.ordinalPosition}`);
    }
    if (leftColumn.isPrimaryKey !== rightColumn.isPrimaryKey) {
        changes.push("Primary key participation changed");
    }
    if (Math.sign(leftColumn.uniqueConstraintNames.length) !== Math.sign(rightColumn.uniqueConstraintNames.length)) {
        changes.push("Unique constraint participation changed");
    }
    if (Math.sign(leftColumn.foreignKeyConstraintNames.length) !== Math.sign(rightColumn.foreignKeyConstraintNames.length)) {
        changes.push("Foreign key participation changed");
    }
    return {
        score: roundScore(name + type + constraints + order),
        breakdown: {
            name: roundScore(name),
            constraints: roundScore(constraints),
            type: roundScore(type),
            order: roundScore(order)
        },
        changes
    };
}
function average(values) {
    if (values.length === 0) {
        return 1;
    }
    return values.reduce((sum, value)=>sum + value, 0) / values.length;
}
function pairwiseAverageBestScore(leftTable, rightTable) {
    if (leftTable.columns.length === 0 && rightTable.columns.length === 0) {
        return 1;
    }
    const leftScores = leftTable.columns.map((leftColumn)=>Math.max(0, ...rightTable.columns.map((rightColumn)=>compareColumnPair(leftTable, leftColumn, rightTable, rightColumn).score / 60)));
    const rightScores = rightTable.columns.map((rightColumn)=>Math.max(0, ...leftTable.columns.map((leftColumn)=>compareColumnPair(leftTable, leftColumn, rightTable, rightColumn).score / 60)));
    return average([
        ...leftScores,
        ...rightScores
    ]);
}
function constraintFamilySimilarity(leftTable, rightTable) {
    const primaryKeySimilarity = (()=>{
        if (!leftTable.primaryKey && !rightTable.primaryKey) {
            return 1;
        }
        if (!leftTable.primaryKey || !rightTable.primaryKey) {
            return 0;
        }
        return setSimilarity(leftTable.primaryKey.columns, rightTable.primaryKey.columns);
    })();
    const uniqueSimilarity = setSimilarity(leftTable.uniqueConstraints.map(uniqueConstraintSignature), rightTable.uniqueConstraints.map(uniqueConstraintSignature));
    const foreignKeySimilarity = setSimilarity(leftTable.foreignKeys.map(foreignKeyLogicalSignature), rightTable.foreignKeys.map(foreignKeyLogicalSignature));
    const checkSimilarity = setSimilarity(leftTable.checkConstraints.map(definitionSignature), rightTable.checkConstraints.map(definitionSignature));
    const excludeSimilarity = setSimilarity(leftTable.excludeConstraints.map(definitionSignature), rightTable.excludeConstraints.map(definitionSignature));
    return average([
        primaryKeySimilarity,
        uniqueSimilarity,
        foreignKeySimilarity,
        checkSimilarity,
        excludeSimilarity
    ]);
}
function compareTablePair(leftTable, rightTable) {
    const name = stringSimilarity(leftTable.name, rightTable.name) * 20;
    const constraints = constraintFamilySimilarity(leftTable, rightTable) * 20;
    const columns = pairwiseAverageBestScore(leftTable, rightTable) * 60;
    return {
        score: roundScore(name + constraints + columns),
        breakdown: {
            name: roundScore(name),
            constraints: roundScore(constraints),
            columns: roundScore(columns)
        }
    };
}
function getBestMatches(leftItems, rightItems, computeScore, acceptThreshold, possibleThreshold, kind, getLeftName, getRightName) {
    const leftBest = new Map();
    const rightBest = new Map();
    const matrix = new Map();
    for(let leftIndex = 0; leftIndex < leftItems.length; leftIndex += 1){
        for(let rightIndex = 0; rightIndex < rightItems.length; rightIndex += 1){
            const result = computeScore(leftItems[leftIndex], rightItems[rightIndex]);
            matrix.set(`${leftIndex}:${rightIndex}`, result);
            const currentLeft = leftBest.get(leftIndex);
            if (!currentLeft || result.score > currentLeft.score) {
                leftBest.set(leftIndex, {
                    index: rightIndex,
                    score: result.score,
                    breakdown: result.breakdown
                });
            }
            const currentRight = rightBest.get(rightIndex);
            if (!currentRight || result.score > currentRight.score) {
                rightBest.set(rightIndex, {
                    index: leftIndex,
                    score: result.score,
                    breakdown: result.breakdown
                });
            }
        }
    }
    const accepted = [];
    const possible = [];
    const matchedLeft = new Set();
    const matchedRight = new Set();
    for (const [leftIndex, match] of leftBest.entries()){
        const reverse = rightBest.get(match.index);
        if (!reverse || reverse.index !== leftIndex) {
            continue;
        }
        if (match.score >= acceptThreshold) {
            accepted.push({
                left: leftItems[leftIndex],
                right: rightItems[match.index],
                score: match.score,
                breakdown: match.breakdown
            });
            matchedLeft.add(leftIndex);
            matchedRight.add(match.index);
            continue;
        }
        if (match.score >= possibleThreshold) {
            possible.push({
                kind,
                leftName: getLeftName(leftItems[leftIndex]),
                rightName: getRightName(rightItems[match.index]),
                score: match.score,
                accepted: false,
                breakdown: match.breakdown
            });
        }
    }
    return {
        accepted,
        possible,
        leftOnly: leftItems.filter((_, index)=>!matchedLeft.has(index)),
        rightOnly: rightItems.filter((_, index)=>!matchedRight.has(index))
    };
}
function compareColumns(leftTable, rightTable) {
    const leftByName = new Map(leftTable.columns.map((column)=>[
            normalizeIdentifier(column.name),
            column
        ]));
    const rightByName = new Map(rightTable.columns.map((column)=>[
            normalizeIdentifier(column.name),
            column
        ]));
    const matchedRightNames = new Set();
    const columnMatches = [];
    for (const [name, leftColumn] of leftByName.entries()){
        const rightColumn = rightByName.get(name);
        if (!rightColumn) {
            continue;
        }
        matchedRightNames.add(name);
        const result = compareColumnPair(leftTable, leftColumn, rightTable, rightColumn);
        columnMatches.push({
            left: leftColumn,
            right: rightColumn,
            score: result.score,
            exact: true,
            breakdown: result.breakdown,
            changes: result.changes
        });
    }
    const leftOnlyForSimilarity = leftTable.columns.filter((column)=>!rightByName.has(normalizeIdentifier(column.name)));
    const rightOnlyForSimilarity = rightTable.columns.filter((column)=>!matchedRightNames.has(normalizeIdentifier(column.name)));
    const similarityResults = getBestMatches(leftOnlyForSimilarity, rightOnlyForSimilarity, (leftColumn, rightColumn)=>{
        const result = compareColumnPair(leftTable, leftColumn, rightTable, rightColumn);
        return {
            score: result.score,
            breakdown: result.breakdown
        };
    }, COLUMN_MATCH_ACCEPT_THRESHOLD, COLUMN_MATCH_POSSIBLE_THRESHOLD, "column", (column)=>column.name, (column)=>column.name);
    for (const match of similarityResults.accepted){
        const result = compareColumnPair(leftTable, match.left, rightTable, match.right);
        columnMatches.push({
            left: match.left,
            right: match.right,
            score: match.score,
            exact: false,
            breakdown: match.breakdown,
            changes: result.changes
        });
    }
    return {
        columnMatches: columnMatches.sort((a, b)=>{
            if (a.left.ordinalPosition !== b.left.ordinalPosition) {
                return a.left.ordinalPosition - b.left.ordinalPosition;
            }
            return a.left.name.localeCompare(b.left.name);
        }),
        columnsOnlyInA: similarityResults.leftOnly,
        columnsOnlyInB: similarityResults.rightOnly,
        possibleColumnMatches: similarityResults.possible
    };
}
function comparePrimaryKey(left, right) {
    if (!left.primaryKey && !right.primaryKey) {
        return [];
    }
    if (left.primaryKey && !right.primaryKey) {
        return [
            {
                kind: "PRIMARY KEY",
                status: "onlyA",
                summary: `Primary key ${left.primaryKey.name} exists only in ${left.name}.`,
                leftName: left.primaryKey.name
            }
        ];
    }
    if (!left.primaryKey && right.primaryKey) {
        return [
            {
                kind: "PRIMARY KEY",
                status: "onlyB",
                summary: `Primary key ${right.primaryKey.name} exists only in ${right.name}.`,
                rightName: right.primaryKey.name
            }
        ];
    }
    if (primaryKeySignature(left.primaryKey) !== primaryKeySignature(right.primaryKey) || left.primaryKey?.normalizedDefinition !== right.primaryKey?.normalizedDefinition) {
        return [
            {
                kind: "PRIMARY KEY",
                status: "changedDefinition",
                summary: `Primary key changed from (${left.primaryKey?.columns.join(", ")}) to (${right.primaryKey?.columns.join(", ")}).`,
                leftName: left.primaryKey?.name,
                rightName: right.primaryKey?.name
            }
        ];
    }
    return [];
}
function compareUniqueConstraints(left, right) {
    const diffs = [];
    const rightByName = new Map(right.uniqueConstraints.map((constraint)=>[
            normalizeIdentifier(constraint.name),
            constraint
        ]));
    const rightBySignature = new Map(right.uniqueConstraints.map((constraint)=>[
            uniqueConstraintSignature(constraint),
            constraint
        ]));
    const matchedRight = new Set();
    for (const constraint of left.uniqueConstraints){
        const byName = rightByName.get(normalizeIdentifier(constraint.name));
        if (byName) {
            matchedRight.add(byName.name);
            if (uniqueConstraintSignature(constraint) !== uniqueConstraintSignature(byName) || constraint.normalizedDefinition !== byName.normalizedDefinition) {
                diffs.push({
                    kind: "UNIQUE",
                    status: "changedDefinition",
                    summary: `Unique constraint ${constraint.name} changed definition.`,
                    leftName: constraint.name,
                    rightName: byName.name
                });
            }
            continue;
        }
        const bySignature = rightBySignature.get(uniqueConstraintSignature(constraint));
        if (bySignature) {
            matchedRight.add(bySignature.name);
            continue;
        }
        diffs.push({
            kind: "UNIQUE",
            status: "onlyA",
            summary: `Unique constraint ${constraint.name} exists only in ${left.name}.`,
            leftName: constraint.name
        });
    }
    for (const constraint of right.uniqueConstraints){
        if (matchedRight.has(constraint.name)) {
            continue;
        }
        diffs.push({
            kind: "UNIQUE",
            status: "onlyB",
            summary: `Unique constraint ${constraint.name} exists only in ${right.name}.`,
            rightName: constraint.name
        });
    }
    return diffs;
}
function compareForeignKeys(left, right) {
    const diffs = [];
    const rightByName = new Map(right.foreignKeys.map((foreignKey)=>[
            normalizeIdentifier(foreignKey.name),
            foreignKey
        ]));
    const rightBySignature = new Map(right.foreignKeys.map((foreignKey)=>[
            foreignKeyLogicalSignature(foreignKey),
            foreignKey
        ]));
    const matchedRight = new Set();
    for (const foreignKey of left.foreignKeys){
        const byName = rightByName.get(normalizeIdentifier(foreignKey.name));
        if (byName) {
            matchedRight.add(byName.name);
            if (foreignKeyLogicalSignature(foreignKey) !== foreignKeyLogicalSignature(byName) || foreignKey.normalizedDefinition !== byName.normalizedDefinition) {
                diffs.push({
                    kind: "FOREIGN KEY",
                    status: "changedDefinition",
                    summary: `Foreign key ${foreignKey.name} changed definition.`,
                    leftName: foreignKey.name,
                    rightName: byName.name
                });
            }
            continue;
        }
        const bySignature = rightBySignature.get(foreignKeyLogicalSignature(foreignKey));
        if (bySignature) {
            matchedRight.add(bySignature.name);
            continue;
        }
        diffs.push({
            kind: "FOREIGN KEY",
            status: "onlyA",
            summary: `Foreign key ${foreignKey.name} exists only in ${left.name}.`,
            leftName: foreignKey.name
        });
    }
    for (const foreignKey of right.foreignKeys){
        if (matchedRight.has(foreignKey.name)) {
            continue;
        }
        diffs.push({
            kind: "FOREIGN KEY",
            status: "onlyB",
            summary: `Foreign key ${foreignKey.name} exists only in ${right.name}.`,
            rightName: foreignKey.name
        });
    }
    return diffs;
}
function compareDefinitionConstraints(kind, leftConstraints, rightConstraints, leftTableName, rightTableName) {
    const diffs = [];
    const rightByName = new Map(rightConstraints.map((constraint)=>[
            normalizeIdentifier(constraint.name),
            constraint
        ]));
    const rightByDefinition = new Map(rightConstraints.map((constraint)=>[
            constraint.normalizedDefinition,
            constraint
        ]));
    const matchedRight = new Set();
    for (const constraint of leftConstraints){
        const byName = rightByName.get(normalizeIdentifier(constraint.name));
        if (byName) {
            matchedRight.add(byName.name);
            if (constraint.normalizedDefinition !== byName.normalizedDefinition) {
                diffs.push({
                    kind,
                    status: "changedDefinition",
                    summary: `${kind} constraint ${constraint.name} changed definition.`,
                    leftName: constraint.name,
                    rightName: byName.name
                });
            }
            continue;
        }
        const byDefinition = rightByDefinition.get(constraint.normalizedDefinition);
        if (byDefinition) {
            matchedRight.add(byDefinition.name);
            continue;
        }
        diffs.push({
            kind,
            status: "onlyA",
            summary: `${kind} constraint ${constraint.name} exists only in ${leftTableName}.`,
            leftName: constraint.name
        });
    }
    for (const constraint of rightConstraints){
        if (matchedRight.has(constraint.name)) {
            continue;
        }
        diffs.push({
            kind,
            status: "onlyB",
            summary: `${kind} constraint ${constraint.name} exists only in ${rightTableName}.`,
            rightName: constraint.name
        });
    }
    return diffs;
}
function compareConstraints(left, right) {
    return [
        ...comparePrimaryKey(left, right),
        ...compareUniqueConstraints(left, right),
        ...compareForeignKeys(left, right),
        ...compareDefinitionConstraints("CHECK", left.checkConstraints, right.checkConstraints, left.name, right.name),
        ...compareDefinitionConstraints("EXCLUDE", left.excludeConstraints, right.excludeConstraints, left.name, right.name)
    ];
}
function compareMatchedTables(left, right, score, exact, breakdown) {
    const columnResult = compareColumns(left, right);
    const constraintDiffs = compareConstraints(left, right);
    const changedSections = new Set();
    if (columnResult.columnsOnlyInA.length > 0 || columnResult.columnsOnlyInB.length > 0 || columnResult.columnMatches.some((match)=>match.changes.length > 0)) {
        changedSections.add("Columns");
    }
    if (constraintDiffs.some((diff)=>diff.kind === "PRIMARY KEY")) {
        changedSections.add("Primary key");
    }
    if (constraintDiffs.some((diff)=>diff.kind === "UNIQUE")) {
        changedSections.add("Unique constraints");
    }
    if (constraintDiffs.some((diff)=>diff.kind === "FOREIGN KEY")) {
        changedSections.add("Foreign keys");
    }
    if (constraintDiffs.some((diff)=>diff.kind === "CHECK")) {
        changedSections.add("Check constraints");
    }
    if (constraintDiffs.some((diff)=>diff.kind === "EXCLUDE")) {
        changedSections.add("Exclude constraints");
    }
    if (!exact) {
        changedSections.add("Similarity matched");
    }
    return {
        left,
        right,
        score,
        exact,
        breakdown,
        columnMatches: columnResult.columnMatches,
        columnsOnlyInA: columnResult.columnsOnlyInA,
        columnsOnlyInB: columnResult.columnsOnlyInB,
        possibleColumnMatches: columnResult.possibleColumnMatches,
        constraintDiffs,
        changedSections: Array.from(changedSections),
        hasChanges: !exact || columnResult.columnsOnlyInA.length > 0 || columnResult.columnsOnlyInB.length > 0 || columnResult.columnMatches.some((match)=>match.changes.length > 0) || constraintDiffs.length > 0
    };
}
function compareSchemas(left, right) {
    const rightByName = new Map(right.tables.map((table)=>[
            normalizeIdentifier(table.name),
            table
        ]));
    const matchedRightNames = new Set();
    const matchedTables = [];
    for (const leftTable of left.tables){
        const rightTable = rightByName.get(normalizeIdentifier(leftTable.name));
        if (!rightTable) {
            continue;
        }
        const scoreResult = compareTablePair(leftTable, rightTable);
        matchedRightNames.add(normalizeIdentifier(rightTable.name));
        matchedTables.push(compareMatchedTables(leftTable, rightTable, scoreResult.score, true, scoreResult.breakdown));
    }
    const leftForSimilarity = left.tables.filter((table)=>!rightByName.has(normalizeIdentifier(table.name)));
    const rightForSimilarity = right.tables.filter((table)=>!matchedRightNames.has(normalizeIdentifier(table.name)));
    const similarityResults = getBestMatches(leftForSimilarity, rightForSimilarity, compareTablePair, TABLE_MATCH_ACCEPT_THRESHOLD, TABLE_MATCH_POSSIBLE_THRESHOLD, "table", (table)=>table.name, (table)=>table.name);
    for (const match of similarityResults.accepted){
        matchedTables.push(compareMatchedTables(match.left, match.right, match.score, false, match.breakdown));
    }
    const changedTables = matchedTables.filter((table)=>table.hasChanges).length;
    const changedConstraints = matchedTables.reduce((sum, table)=>{
        return sum + table.constraintDiffs.length;
    }, 0);
    const likelyRenameCandidates = matchedTables.filter((table)=>!table.exact).length + similarityResults.possible.length;
    return {
        left,
        right,
        matchedTables: matchedTables.sort((a, b)=>a.left.name.localeCompare(b.left.name)),
        tablesOnlyInA: similarityResults.leftOnly.sort((a, b)=>a.name.localeCompare(b.name)),
        tablesOnlyInB: similarityResults.rightOnly.sort((a, b)=>a.name.localeCompare(b.name)),
        possibleTableMatches: similarityResults.possible.sort((a, b)=>b.score - a.score || a.leftName.localeCompare(b.leftName)),
        summary: {
            tablesOnlyInA: similarityResults.leftOnly.length,
            tablesOnlyInB: similarityResults.rightOnly.length,
            changedTables,
            changedConstraints,
            likelyRenameCandidates,
            identicalTables: matchedTables.filter((table)=>!table.hasChanges).length
        }
    };
}
function summarizeColumns(columns) {
    if (columns.length === 0) {
        return "None";
    }
    return columns.map((column)=>`${column.name} (${column.typeDisplay})`).join(", ");
}
function describeConstraint(constraint) {
    if (constraint.kind === "FOREIGN KEY") {
        return `${constraint.name}: (${constraint.columns.join(", ")}) -> ${constraint.referencedTable ?? "unknown"} (${constraint.referencedColumns.join(", ")})`;
    }
    if (constraint.columns.length > 0) {
        return `${constraint.name}: ${constraint.columns.join(", ")}`;
    }
    return `${constraint.name}: ${constraint.definition}`;
}
function describeTableMatch(tableMatch) {
    if (tableMatch.exact) {
        if (!tableMatch.hasChanges && tableMatch.score === 100) {
            return "Exact table name match with identical structure.";
        }
        return `Matched by exact table name. Structural similarity score: ${tableMatch.score}%.`;
    }
    const decision = matchDecision(tableMatch.score, TABLE_MATCH_ACCEPT_THRESHOLD);
    const qualifier = decision === "accepted" ? "Accepted similarity match" : "Possible similarity match";
    return `${qualifier} at ${tableMatch.score}%.`;
}
}),
"[project]/app/compare/page.tsx [app-rsc] (ecmascript)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

__turbopack_context__.s([
    "default",
    ()=>ComparePage,
    "dynamic",
    ()=>dynamic
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/server/route-modules/app-page/vendored/rsc/react-jsx-dev-runtime.js [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$components$2f$Sidebar$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/components/Sidebar.tsx [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$components$2f$Topbar$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/components/Topbar.tsx [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$postgres$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/lib/postgres.ts [app-rsc] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$compare$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/lib/compare.ts [app-rsc] (ecmascript)");
var __turbopack_async_dependencies__ = __turbopack_handle_async_dependencies__([
    __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$postgres$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__
]);
[__TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$postgres$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__] = __turbopack_async_dependencies__.then ? (await __turbopack_async_dependencies__)() : __turbopack_async_dependencies__;
;
;
;
;
;
const dynamic = "force-dynamic";
function envValue(name, fallback) {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : fallback;
}
function pickValue(value, fallback) {
    if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
    }
    if (Array.isArray(value) && value[0]?.trim()) {
        return value[0].trim();
    }
    return fallback;
}
function getTargetById(targets, id) {
    return targets.find((target)=>target.id === id) ?? targets[0];
}
function scoreBreakdownLabel(candidate) {
    if (candidate.kind === "table") {
        return `Name ${candidate.breakdown.name}, constraints ${candidate.breakdown.constraints}, columns ${candidate.breakdown.columns ?? 0}`;
    }
    return `Name ${candidate.breakdown.name}, type ${candidate.breakdown.type ?? 0}, constraints ${candidate.breakdown.constraints}, order ${candidate.breakdown.order ?? 0}`;
}
function groupConstraintDiffs(diffs) {
    return {
        "PRIMARY KEY": diffs.filter((diff)=>diff.kind === "PRIMARY KEY"),
        UNIQUE: diffs.filter((diff)=>diff.kind === "UNIQUE"),
        "FOREIGN KEY": diffs.filter((diff)=>diff.kind === "FOREIGN KEY"),
        CHECK: diffs.filter((diff)=>diff.kind === "CHECK"),
        EXCLUDE: diffs.filter((diff)=>diff.kind === "EXCLUDE")
    };
}
function renderTableList(title, tables, sideClass) {
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("section", {
        className: "compare-report-block",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "compare-report-block__header",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h3", {
                        className: "compare-report-block__title",
                        children: title
                    }, void 0, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 74,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: `compare-pill ${sideClass}`,
                        children: tables.length
                    }, void 0, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 75,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 73,
                columnNumber: 7
            }, this),
            tables.length === 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                className: "compare-hint",
                children: "None."
            }, void 0, false, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 78,
                columnNumber: 9
            }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "compare-stack",
                children: tables.map((table)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "compare-note-card",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "compare-note-card__title",
                                children: table.name
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 83,
                                columnNumber: 15
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "compare-note-card__text",
                                children: [
                                    "Columns: ",
                                    (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$compare$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["summarizeColumns"])(table.columns)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 84,
                                columnNumber: 15
                            }, this)
                        ]
                    }, table.name, true, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 82,
                        columnNumber: 13
                    }, this))
            }, void 0, false, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 80,
                columnNumber: 9
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/app/compare/page.tsx",
        lineNumber: 72,
        columnNumber: 5
    }, this);
}
function renderRenameSection(report) {
    const accepted = report.matchedTables.filter((table)=>!table.exact);
    const possible = report.possibleTableMatches;
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("section", {
        className: "compare-report-block",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "compare-report-block__header",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h3", {
                        className: "compare-report-block__title",
                        children: "Likely Rename Candidates"
                    }, void 0, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 102,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "compare-pill compare-pill--neutral",
                        children: accepted.length + possible.length
                    }, void 0, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 103,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 101,
                columnNumber: 7
            }, this),
            accepted.length === 0 && possible.length === 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                className: "compare-hint",
                children: "No likely renamed tables were detected."
            }, void 0, false, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 109,
                columnNumber: 9
            }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "compare-stack",
                children: [
                    accepted.map((table)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "compare-note-card",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                    className: "compare-note-card__title",
                                    children: [
                                        table.left.name,
                                        " ",
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "compare-arrow",
                                            children: "→"
                                        }, void 0, false, {
                                            fileName: "[project]/app/compare/page.tsx",
                                            lineNumber: 118,
                                            columnNumber: 35
                                        }, this),
                                        " ",
                                        table.right.name
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/app/compare/page.tsx",
                                    lineNumber: 117,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                    className: "compare-note-card__text",
                                    children: [
                                        "Accepted similarity match at ",
                                        table.score,
                                        "%."
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/app/compare/page.tsx",
                                    lineNumber: 121,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                    className: "compare-note-card__meta",
                                    children: [
                                        "Name ",
                                        table.breakdown.name,
                                        ", constraints ",
                                        table.breakdown.constraints,
                                        ", columns ",
                                        table.breakdown.columns ?? 0
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/app/compare/page.tsx",
                                    lineNumber: 124,
                                    columnNumber: 15
                                }, this)
                            ]
                        }, `${table.left.name}-${table.right.name}`, true, {
                            fileName: "[project]/app/compare/page.tsx",
                            lineNumber: 113,
                            columnNumber: 13
                        }, this)),
                    possible.map((candidate)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "compare-note-card compare-note-card--warning",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                    className: "compare-note-card__title",
                                    children: [
                                        candidate.leftName,
                                        " ",
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                            className: "compare-arrow",
                                            children: "?"
                                        }, void 0, false, {
                                            fileName: "[project]/app/compare/page.tsx",
                                            lineNumber: 137,
                                            columnNumber: 38
                                        }, this),
                                        " ",
                                        candidate.rightName
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/app/compare/page.tsx",
                                    lineNumber: 136,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                    className: "compare-note-card__text",
                                    children: [
                                        "Possible match at ",
                                        candidate.score,
                                        "%."
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/app/compare/page.tsx",
                                    lineNumber: 140,
                                    columnNumber: 15
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                    className: "compare-note-card__meta",
                                    children: scoreBreakdownLabel(candidate)
                                }, void 0, false, {
                                    fileName: "[project]/app/compare/page.tsx",
                                    lineNumber: 143,
                                    columnNumber: 15
                                }, this)
                            ]
                        }, `${candidate.leftName}-${candidate.rightName}`, true, {
                            fileName: "[project]/app/compare/page.tsx",
                            lineNumber: 132,
                            columnNumber: 13
                        }, this))
                ]
            }, void 0, true, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 111,
                columnNumber: 9
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/app/compare/page.tsx",
        lineNumber: 100,
        columnNumber: 5
    }, this);
}
function renderConstraintGroup(title, diffs, tableMatch) {
    if (diffs.length === 0) {
        return null;
    }
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "compare-detail-group",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h5", {
                className: "compare-detail-group__title",
                children: title
            }, void 0, false, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 165,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
                className: "compare-bullet-list",
                children: diffs.map((diff)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                        className: "compare-bullet-list__item",
                        children: diff.summary
                    }, `${title}-${diff.summary}`, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 168,
                        columnNumber: 11
                    }, this))
            }, void 0, false, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 166,
                columnNumber: 7
            }, this),
            title === "Foreign Keys" && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "compare-constraint-catalog",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "compare-constraint-catalog__column",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "compare-constraint-catalog__label",
                                children: tableMatch.left.name
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 176,
                                columnNumber: 13
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
                                className: "compare-bullet-list",
                                children: tableMatch.left.foreignKeys.map((constraint)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                        className: "compare-bullet-list__item",
                                        children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$compare$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["describeConstraint"])(constraint)
                                    }, `${tableMatch.left.name}-${constraint.name}`, false, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 181,
                                        columnNumber: 17
                                    }, this))
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 179,
                                columnNumber: 13
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 175,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "compare-constraint-catalog__column",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "compare-constraint-catalog__label",
                                children: tableMatch.right.name
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 191,
                                columnNumber: 13
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
                                className: "compare-bullet-list",
                                children: tableMatch.right.foreignKeys.map((constraint)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                        className: "compare-bullet-list__item",
                                        children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$compare$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["describeConstraint"])(constraint)
                                    }, `${tableMatch.right.name}-${constraint.name}`, false, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 196,
                                        columnNumber: 17
                                    }, this))
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 194,
                                columnNumber: 13
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 190,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 174,
                columnNumber: 9
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/app/compare/page.tsx",
        lineNumber: 164,
        columnNumber: 5
    }, this);
}
function renderMatchedTable(tableMatch) {
    const groupedConstraints = groupConstraintDiffs(tableMatch.constraintDiffs);
    const changedColumns = tableMatch.columnMatches.filter((match)=>match.changes.length > 0);
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("article", {
        className: "compare-result-card",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "compare-result-card__header",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h3", {
                                className: "compare-result-card__title",
                                children: [
                                    tableMatch.left.name,
                                    tableMatch.exact ? null : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["Fragment"], {
                                        children: [
                                            " ",
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "compare-arrow",
                                                children: "→"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 229,
                                                columnNumber: 17
                                            }, this),
                                            " ",
                                            tableMatch.right.name
                                        ]
                                    }, void 0, true)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 224,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "compare-result-card__subtitle",
                                children: (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$compare$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["describeTableMatch"])(tableMatch)
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 233,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 223,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: `compare-pill ${tableMatch.hasChanges ? "compare-pill--warning" : "compare-pill--success"}`,
                        children: tableMatch.hasChanges ? "Differences found" : "No differences"
                    }, void 0, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 237,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 222,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                className: "compare-note-card__meta compare-note-card__meta--inline",
                children: [
                    "Name ",
                    tableMatch.breakdown.name,
                    ", constraints ",
                    tableMatch.breakdown.constraints,
                    ", columns ",
                    tableMatch.breakdown.columns ?? 0
                ]
            }, void 0, true, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 248,
                columnNumber: 7
            }, this),
            tableMatch.changedSections.length > 0 && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "compare-chip-row",
                children: tableMatch.changedSections.map((section)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                        className: "compare-chip",
                        children: section
                    }, section, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 256,
                        columnNumber: 13
                    }, this))
            }, void 0, false, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 254,
                columnNumber: 9
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "compare-detail-grid",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "compare-detail-group",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h5", {
                                className: "compare-detail-group__title",
                                children: "Columns Only In A"
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 265,
                                columnNumber: 11
                            }, this),
                            tableMatch.columnsOnlyInA.length === 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "compare-hint",
                                children: "None."
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 267,
                                columnNumber: 13
                            }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
                                className: "compare-bullet-list",
                                children: tableMatch.columnsOnlyInA.map((column)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                        className: "compare-bullet-list__item",
                                        children: [
                                            column.name,
                                            " (",
                                            column.typeDisplay,
                                            ")"
                                        ]
                                    }, `${tableMatch.left.name}-${column.name}`, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 271,
                                        columnNumber: 17
                                    }, this))
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 269,
                                columnNumber: 13
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 264,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "compare-detail-group",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h5", {
                                className: "compare-detail-group__title",
                                children: "Columns Only In B"
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 283,
                                columnNumber: 11
                            }, this),
                            tableMatch.columnsOnlyInB.length === 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                className: "compare-hint",
                                children: "None."
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 285,
                                columnNumber: 13
                            }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
                                className: "compare-bullet-list",
                                children: tableMatch.columnsOnlyInB.map((column)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                        className: "compare-bullet-list__item",
                                        children: [
                                            column.name,
                                            " (",
                                            column.typeDisplay,
                                            ")"
                                        ]
                                    }, `${tableMatch.right.name}-${column.name}`, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 289,
                                        columnNumber: 17
                                    }, this))
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 287,
                                columnNumber: 13
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 282,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 263,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "compare-detail-group",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h5", {
                        className: "compare-detail-group__title",
                        children: "Changed Matched Columns"
                    }, void 0, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 302,
                        columnNumber: 9
                    }, this),
                    changedColumns.length === 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                        className: "compare-hint",
                        children: "No matched columns changed."
                    }, void 0, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 304,
                        columnNumber: 11
                    }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "compare-stack",
                        children: changedColumns.map((match)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "compare-note-card compare-note-card--subtle",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                        className: "compare-note-card__title",
                                        children: [
                                            match.left.name,
                                            match.exact ? null : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["Fragment"], {
                                                children: [
                                                    " ",
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "compare-arrow",
                                                        children: "→"
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 317,
                                                        columnNumber: 23
                                                    }, this),
                                                    " ",
                                                    match.right.name
                                                ]
                                            }, void 0, true)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 312,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("ul", {
                                        className: "compare-bullet-list",
                                        children: match.changes.map((change)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("li", {
                                                className: "compare-bullet-list__item",
                                                children: change
                                            }, `${match.left.name}-${change}`, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 323,
                                                columnNumber: 21
                                            }, this))
                                    }, void 0, false, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 321,
                                        columnNumber: 17
                                    }, this)
                                ]
                            }, `${tableMatch.left.name}-${match.left.name}-${match.right.name}`, true, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 308,
                                columnNumber: 15
                            }, this))
                    }, void 0, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 306,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 301,
                columnNumber: 7
            }, this),
            tableMatch.possibleColumnMatches.length > 0 && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "compare-detail-group",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h5", {
                        className: "compare-detail-group__title",
                        children: "Possible Renamed Columns"
                    }, void 0, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 339,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "compare-stack",
                        children: tableMatch.possibleColumnMatches.map((candidate)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "compare-note-card compare-note-card--warning",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                        className: "compare-note-card__title",
                                        children: [
                                            candidate.leftName,
                                            " ",
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "compare-arrow",
                                                children: "?"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 347,
                                                columnNumber: 40
                                            }, this),
                                            " ",
                                            candidate.rightName
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 346,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                        className: "compare-note-card__text",
                                        children: [
                                            "Possible match at ",
                                            candidate.score,
                                            "%."
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 350,
                                        columnNumber: 17
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                        className: "compare-note-card__meta",
                                        children: scoreBreakdownLabel(candidate)
                                    }, void 0, false, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 353,
                                        columnNumber: 17
                                    }, this)
                                ]
                            }, `${tableMatch.left.name}-${candidate.leftName}-${candidate.rightName}`, true, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 342,
                                columnNumber: 15
                            }, this))
                    }, void 0, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 340,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 338,
                columnNumber: 9
            }, this),
            renderConstraintGroup("Primary Key", groupedConstraints["PRIMARY KEY"], tableMatch),
            renderConstraintGroup("Unique Constraints", groupedConstraints.UNIQUE, tableMatch),
            renderConstraintGroup("Foreign Keys", groupedConstraints["FOREIGN KEY"], tableMatch),
            renderConstraintGroup("Check Constraints", groupedConstraints.CHECK, tableMatch),
            renderConstraintGroup("Exclude Constraints", groupedConstraints.EXCLUDE, tableMatch)
        ]
    }, `${tableMatch.left.name}-${tableMatch.right.name}`, true, {
        fileName: "[project]/app/compare/page.tsx",
        lineNumber: 218,
        columnNumber: 5
    }, this);
}
async function ComparePage({ searchParams }) {
    const params = await searchParams;
    const resolved = (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$postgres$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["resolveCompareTargets"])();
    if (!resolved.ok) {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "db-layout",
            children: [
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$components$2f$Sidebar$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"], {
                    current: "Schema Comparison"
                }, void 0, false, {
                    fileName: "[project]/app/compare/page.tsx",
                    lineNumber: 378,
                    columnNumber: 9
                }, this),
                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("main", {
                    className: "db-main",
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$components$2f$Topbar$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"], {
                            title: "Schema Comparison",
                            text: "Week-7 prototype for live PostgreSQL schema diffs."
                        }, void 0, false, {
                            fileName: "[project]/app/compare/page.tsx",
                            lineNumber: 380,
                            columnNumber: 11
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "compare-card",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                    className: "compare-card__title",
                                    children: "PostgreSQL Targets"
                                }, void 0, false, {
                                    fileName: "[project]/app/compare/page.tsx",
                                    lineNumber: 385,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                    className: "compare-hint compare-hint--error",
                                    children: resolved.error
                                }, void 0, false, {
                                    fileName: "[project]/app/compare/page.tsx",
                                    lineNumber: 386,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                    className: "compare-hint",
                                    children: [
                                        "Configure ",
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("code", {
                                            className: "compare-code",
                                            children: "DATABASE_URL"
                                        }, void 0, false, {
                                            fileName: "[project]/app/compare/page.tsx",
                                            lineNumber: 388,
                                            columnNumber: 25
                                        }, this),
                                        " or the pair ",
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("code", {
                                            className: "compare-code",
                                            children: "DATABASE_URL_A"
                                        }, void 0, false, {
                                            fileName: "[project]/app/compare/page.tsx",
                                            lineNumber: 389,
                                            columnNumber: 20
                                        }, this),
                                        " /",
                                        " ",
                                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("code", {
                                            className: "compare-code",
                                            children: "DATABASE_URL_B"
                                        }, void 0, false, {
                                            fileName: "[project]/app/compare/page.tsx",
                                            lineNumber: 390,
                                            columnNumber: 15
                                        }, this),
                                        " to continue."
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/app/compare/page.tsx",
                                    lineNumber: 387,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/app/compare/page.tsx",
                            lineNumber: 384,
                            columnNumber: 11
                        }, this)
                    ]
                }, void 0, true, {
                    fileName: "[project]/app/compare/page.tsx",
                    lineNumber: 379,
                    columnNumber: 9
                }, this)
            ]
        }, void 0, true, {
            fileName: "[project]/app/compare/page.tsx",
            lineNumber: 377,
            columnNumber: 7
        }, this);
    }
    const targets = [
        resolved.a,
        resolved.b
    ];
    const defaultLeftDb = pickValue(params.leftDb, resolved.a.id);
    const defaultRightDb = pickValue(params.rightDb, resolved.b.id);
    const leftTarget = getTargetById(targets, defaultLeftDb);
    const rightTarget = getTargetById(targets, defaultRightDb);
    const [schemasA, schemasB] = await Promise.all([
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$postgres$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["fetchSchemaNames"])(resolved.a.config),
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$postgres$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["fetchSchemaNames"])(resolved.b.config)
    ]);
    const schemaErrors = [
        schemasA,
        schemasB
    ].filter((result)=>!result.ok);
    const schemaMap = new Map();
    if (schemasA.ok) {
        schemaMap.set(resolved.a.id, schemasA.data);
    }
    if (schemasB.ok) {
        schemaMap.set(resolved.b.id, schemasB.data);
    }
    const leftSchemaOptions = schemaMap.get(leftTarget.id) ?? [];
    const rightSchemaOptions = schemaMap.get(rightTarget.id) ?? [];
    const leftSchemaFallback = leftSchemaOptions.find((schema)=>schema === envValue("COMPARE_SCHEMA_A", "public")) ?? leftSchemaOptions[0] ?? envValue("COMPARE_SCHEMA_A", "public");
    const rightSchemaFallback = rightSchemaOptions.find((schema)=>schema === envValue("COMPARE_SCHEMA_B", "public")) ?? rightSchemaOptions[0] ?? envValue("COMPARE_SCHEMA_B", "public");
    const leftSchema = pickValue(params.leftSchema, leftSchemaFallback);
    const rightSchema = pickValue(params.rightSchema, rightSchemaFallback);
    const selectionErrors = [];
    if (leftSchemaOptions.length > 0 && !leftSchemaOptions.includes(leftSchema)) {
        selectionErrors.push(`Schema ${leftSchema} was not found in ${leftTarget.displayName}.`);
    }
    if (rightSchemaOptions.length > 0 && !rightSchemaOptions.includes(rightSchema)) {
        selectionErrors.push(`Schema ${rightSchema} was not found in ${rightTarget.displayName}.`);
    }
    let report = null;
    const compareErrors = [
        ...schemaErrors.filter((result)=>!result.ok).map((result)=>result.error),
        ...selectionErrors
    ];
    if (compareErrors.length === 0) {
        const [leftSnapshot, rightSnapshot] = await Promise.all([
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$postgres$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["fetchSchemaSnapshot"])(leftTarget.config, leftSchema),
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$postgres$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["fetchSchemaSnapshot"])(rightTarget.config, rightSchema)
        ]);
        if (!leftSnapshot.ok) {
            compareErrors.push(`Could not load ${leftTarget.displayName}.${leftSchema}: ${leftSnapshot.error}`);
        }
        if (!rightSnapshot.ok) {
            compareErrors.push(`Could not load ${rightTarget.displayName}.${rightSchema}: ${rightSnapshot.error}`);
        }
        if (leftSnapshot.ok && rightSnapshot.ok) {
            report = (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$compare$2e$ts__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["compareSchemas"])(leftSnapshot.data, rightSnapshot.data);
        }
    }
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
        className: "db-layout",
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$components$2f$Sidebar$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"], {
                current: "Schema Comparison"
            }, void 0, false, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 477,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("main", {
                className: "db-main",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$components$2f$Topbar$2e$tsx__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["default"], {
                        title: "Schema Comparison",
                        text: "Week-7 prototype for live PostgreSQL schema diffs and constraint analysis."
                    }, void 0, false, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 480,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "compare-card compare-card--setup compare-card--spaced",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "compare-card__header",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                                className: "compare-card__title",
                                                children: "Comparison Setup"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 488,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-hint",
                                                children: "Pick any two schemas from the preset database targets, then review table, column, and constraint differences in one report."
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 489,
                                                columnNumber: 15
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 487,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                        className: "compare-pill compare-pill--neutral",
                                        children: "Diff report only"
                                    }, void 0, false, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 494,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 486,
                                columnNumber: 11
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("form", {
                                action: "/compare",
                                className: "compare-form-grid",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "compare-form-card",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h3", {
                                                className: "compare-form-card__title",
                                                children: "Left Side (A)"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 501,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("label", {
                                                className: "compare-field",
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "compare-field__label",
                                                        children: "Database target"
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 503,
                                                        columnNumber: 17
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("select", {
                                                        name: "leftDb",
                                                        defaultValue: leftTarget.id,
                                                        className: "compare-select",
                                                        children: targets.map((target)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("option", {
                                                                value: target.id,
                                                                children: target.displayName
                                                            }, target.id, false, {
                                                                fileName: "[project]/app/compare/page.tsx",
                                                                lineNumber: 510,
                                                                columnNumber: 21
                                                            }, this))
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 504,
                                                        columnNumber: 17
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 502,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("label", {
                                                className: "compare-field",
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "compare-field__label",
                                                        children: "Schema"
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 517,
                                                        columnNumber: 17
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("select", {
                                                        name: "leftSchema",
                                                        defaultValue: leftSchema,
                                                        className: "compare-select",
                                                        children: leftSchemaOptions.map((schema)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("option", {
                                                                value: schema,
                                                                children: schema
                                                            }, `${leftTarget.id}-${schema}`, false, {
                                                                fileName: "[project]/app/compare/page.tsx",
                                                                lineNumber: 524,
                                                                columnNumber: 21
                                                            }, this))
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 518,
                                                        columnNumber: 17
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 516,
                                                columnNumber: 15
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 500,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "compare-form-card",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h3", {
                                                className: "compare-form-card__title",
                                                children: "Right Side (B)"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 533,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("label", {
                                                className: "compare-field",
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "compare-field__label",
                                                        children: "Database target"
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 535,
                                                        columnNumber: 17
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("select", {
                                                        name: "rightDb",
                                                        defaultValue: rightTarget.id,
                                                        className: "compare-select",
                                                        children: targets.map((target)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("option", {
                                                                value: target.id,
                                                                children: target.displayName
                                                            }, target.id, false, {
                                                                fileName: "[project]/app/compare/page.tsx",
                                                                lineNumber: 542,
                                                                columnNumber: 21
                                                            }, this))
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 536,
                                                        columnNumber: 17
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 534,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("label", {
                                                className: "compare-field",
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "compare-field__label",
                                                        children: "Schema"
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 549,
                                                        columnNumber: 17
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("select", {
                                                        name: "rightSchema",
                                                        defaultValue: rightSchema,
                                                        className: "compare-select",
                                                        children: rightSchemaOptions.map((schema)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("option", {
                                                                value: schema,
                                                                children: schema
                                                            }, `${rightTarget.id}-${schema}`, false, {
                                                                fileName: "[project]/app/compare/page.tsx",
                                                                lineNumber: 556,
                                                                columnNumber: 21
                                                            }, this))
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 550,
                                                        columnNumber: 17
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 548,
                                                columnNumber: 15
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 532,
                                        columnNumber: 13
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "compare-form-actions",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("button", {
                                                type: "submit",
                                                className: "compare-btn compare-btn--primary",
                                                children: "Compare Schemas"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 565,
                                                columnNumber: 15
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-hint compare-hint--tight",
                                                children: [
                                                    "Targets come from ",
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("code", {
                                                        className: "compare-code",
                                                        children: "DATABASE_URL"
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 569,
                                                        columnNumber: 35
                                                    }, this),
                                                    ",",
                                                    " ",
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("code", {
                                                        className: "compare-code",
                                                        children: "DATABASE_URL_A"
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 570,
                                                        columnNumber: 17
                                                    }, this),
                                                    ", and",
                                                    " ",
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("code", {
                                                        className: "compare-code",
                                                        children: "DATABASE_URL_B"
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 571,
                                                        columnNumber: 17
                                                    }, this),
                                                    "."
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 568,
                                                columnNumber: 15
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 564,
                                        columnNumber: 13
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 499,
                                columnNumber: 11
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 485,
                        columnNumber: 9
                    }, this),
                    compareErrors.length > 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "compare-card",
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                className: "compare-card__title",
                                children: "Unable To Compare"
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 579,
                                columnNumber: 13
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "compare-stack",
                                children: compareErrors.map((error)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                        className: "compare-hint compare-hint--error",
                                        children: error
                                    }, error, false, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 582,
                                        columnNumber: 17
                                    }, this))
                            }, void 0, false, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 580,
                                columnNumber: 13
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/app/compare/page.tsx",
                        lineNumber: 578,
                        columnNumber: 11
                    }, this) : null,
                    report ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["Fragment"], {
                        children: [
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "compare-summary-grid",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "compare-summary-card",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-summary-card__label",
                                                children: "Tables Only In A"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 594,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                                className: "compare-summary-card__value",
                                                children: report.summary.tablesOnlyInA
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 595,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-summary-card__hint",
                                                children: [
                                                    report.left.database,
                                                    ".",
                                                    report.left.schema
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 598,
                                                columnNumber: 17
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 593,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "compare-summary-card",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-summary-card__label",
                                                children: "Tables Only In B"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 603,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                                className: "compare-summary-card__value",
                                                children: report.summary.tablesOnlyInB
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 604,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-summary-card__hint",
                                                children: [
                                                    report.right.database,
                                                    ".",
                                                    report.right.schema
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 607,
                                                columnNumber: 17
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 602,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "compare-summary-card",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-summary-card__label",
                                                children: "Changed Matched Tables"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 612,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                                className: "compare-summary-card__value",
                                                children: report.summary.changedTables
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 613,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-summary-card__hint",
                                                children: "Exact + similarity matches"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 616,
                                                columnNumber: 17
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 611,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "compare-summary-card",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-summary-card__label",
                                                children: "Changed Constraints"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 621,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                                className: "compare-summary-card__value",
                                                children: report.summary.changedConstraints
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 622,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-summary-card__hint",
                                                children: "PK, unique, FK, check, exclude"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 625,
                                                columnNumber: 17
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 620,
                                        columnNumber: 15
                                    }, this),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "compare-summary-card",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-summary-card__label",
                                                children: "Likely Rename Candidates"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 630,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                                className: "compare-summary-card__value",
                                                children: report.summary.likelyRenameCandidates
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 633,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-summary-card__hint",
                                                children: "Accepted + possible similarity matches"
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 636,
                                                columnNumber: 17
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 629,
                                        columnNumber: 15
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 592,
                                columnNumber: 13
                            }, this),
                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                className: "compare-card compare-card--spaced",
                                children: [
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "compare-card__header",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h2", {
                                                        className: "compare-card__title",
                                                        children: "Comparison Report"
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 645,
                                                        columnNumber: 19
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                        className: "compare-hint",
                                                        children: [
                                                            "Comparing ",
                                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("code", {
                                                                className: "compare-code",
                                                                children: report.left.database
                                                            }, void 0, false, {
                                                                fileName: "[project]/app/compare/page.tsx",
                                                                lineNumber: 647,
                                                                columnNumber: 31
                                                            }, this),
                                                            ".",
                                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("code", {
                                                                className: "compare-code",
                                                                children: report.left.schema
                                                            }, void 0, false, {
                                                                fileName: "[project]/app/compare/page.tsx",
                                                                lineNumber: 648,
                                                                columnNumber: 21
                                                            }, this),
                                                            " against",
                                                            " ",
                                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("code", {
                                                                className: "compare-code",
                                                                children: report.right.database
                                                            }, void 0, false, {
                                                                fileName: "[project]/app/compare/page.tsx",
                                                                lineNumber: 649,
                                                                columnNumber: 21
                                                            }, this),
                                                            ".",
                                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("code", {
                                                                className: "compare-code",
                                                                children: report.right.schema
                                                            }, void 0, false, {
                                                                fileName: "[project]/app/compare/page.tsx",
                                                                lineNumber: 650,
                                                                columnNumber: 21
                                                            }, this),
                                                            "."
                                                        ]
                                                    }, void 0, true, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 646,
                                                        columnNumber: 19
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 644,
                                                columnNumber: 17
                                            }, this),
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                className: "compare-pill compare-pill--success",
                                                children: [
                                                    report.summary.identicalTables,
                                                    " identical"
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 653,
                                                columnNumber: 17
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 643,
                                        columnNumber: 15
                                    }, this),
                                    report.summary.changedTables === 0 && report.summary.tablesOnlyInA === 0 && report.summary.tablesOnlyInB === 0 && report.summary.changedConstraints === 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                        className: "compare-hint",
                                        children: "No schema differences were detected for the selected pair."
                                    }, void 0, false, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 662,
                                        columnNumber: 17
                                    }, this) : null,
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                        className: "compare-report-grid",
                                        children: [
                                            renderTableList("Tables Only In A", report.tablesOnlyInA, "compare-pill--danger"),
                                            renderTableList("Tables Only In B", report.tablesOnlyInB, "compare-pill--info")
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 667,
                                        columnNumber: 15
                                    }, this),
                                    renderRenameSection(report),
                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("section", {
                                        className: "compare-report-block",
                                        children: [
                                            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                className: "compare-report-block__header",
                                                children: [
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("h3", {
                                                        className: "compare-report-block__title",
                                                        children: "Matched Table Details"
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 684,
                                                        columnNumber: 19
                                                    }, this),
                                                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("span", {
                                                        className: "compare-pill compare-pill--neutral",
                                                        children: report.matchedTables.length
                                                    }, void 0, false, {
                                                        fileName: "[project]/app/compare/page.tsx",
                                                        lineNumber: 685,
                                                        columnNumber: 19
                                                    }, this)
                                                ]
                                            }, void 0, true, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 683,
                                                columnNumber: 17
                                            }, this),
                                            report.matchedTables.length === 0 ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                                                className: "compare-hint",
                                                children: "No table matches were found."
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 691,
                                                columnNumber: 19
                                            }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$server$2f$route$2d$modules$2f$app$2d$page$2f$vendored$2f$rsc$2f$react$2d$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$rsc$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                                className: "compare-stack",
                                                children: report.matchedTables.map((tableMatch)=>renderMatchedTable(tableMatch))
                                            }, void 0, false, {
                                                fileName: "[project]/app/compare/page.tsx",
                                                lineNumber: 693,
                                                columnNumber: 19
                                            }, this)
                                        ]
                                    }, void 0, true, {
                                        fileName: "[project]/app/compare/page.tsx",
                                        lineNumber: 682,
                                        columnNumber: 15
                                    }, this)
                                ]
                            }, void 0, true, {
                                fileName: "[project]/app/compare/page.tsx",
                                lineNumber: 642,
                                columnNumber: 13
                            }, this)
                        ]
                    }, void 0, true) : null
                ]
            }, void 0, true, {
                fileName: "[project]/app/compare/page.tsx",
                lineNumber: 479,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/app/compare/page.tsx",
        lineNumber: 476,
        columnNumber: 5
    }, this);
}
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, false);}),
"[project]/app/compare/page.tsx [app-rsc] (ecmascript, Next.js Server Component)", ((__turbopack_context__) => {

__turbopack_context__.n(__turbopack_context__.i("[project]/app/compare/page.tsx [app-rsc] (ecmascript)"));
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__0nbm626._.js.map
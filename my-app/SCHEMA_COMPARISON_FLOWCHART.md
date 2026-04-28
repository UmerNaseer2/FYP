# Schema Comparison Flowchart

```mermaid
flowchart TD
    A[User selects DB A schema and DB B schema] --> B[fetchSchemaSnapshot for left and right]
    B --> C[Read tables]
    B --> D[Read columns]
    B --> E[Read constraints]
    C --> F[Build SchemaSnapshot]
    D --> F
    E --> F

    F --> G[compareSchemas starts]

    G --> H[Exact table-name matching]
    H --> I{Same exact table name?}
    I -->|Yes| J[compareTablePair]
    J --> K[compareMatchedTables]
    K --> L[compareColumns inside matched table]
    K --> M[compareConstraints inside matched table]
    I -->|No| N[Put table into leftover set]

    N --> O[Similarity matching for leftover tables]
    O --> P[getBestMatches]
    P --> Q[Score every leftover A table against every leftover B table]
    Q --> R[Keep mutual best matches only]
    R --> S{Table score >= 70?}
    S -->|Yes| T[Accepted similarity table match]
    S -->|No, but >= 55| U[Possible rename candidate]
    S -->|No| V[Remain only in A / only in B]

    L --> W[Exact column-name matching first]
    W --> X{Same exact column name?}
    X -->|Yes| Y[compareColumnPair]
    X -->|No| Z[Put column into leftover set]

    Z --> AA[Similarity matching for leftover columns]
    AA --> AB[getBestMatches]
    AB --> AC[Score every leftover A column against every leftover B column]
    AC --> AD[Keep mutual best matches only]
    AD --> AE{Column score >= 50?}
    AE -->|Yes| AF[Accepted renamed column match]
    AE -->|No, but >= 40| AG[Possible renamed column]
    AE -->|No| AH[Remain only in A / only in B]

    M --> AI[Compare primary key]
    M --> AJ[Compare unique constraints]
    M --> AK[Compare foreign keys]
    M --> AL[Compare check constraints]
    M --> AM[Compare exclude constraints]

    T --> AN[Build matchedTables list]
    U --> AO[Build possibleTableMatches list]
    V --> AP[Build tablesOnlyInA and tablesOnlyInB]
    AF --> AQ[Build columnMatches list]
    AG --> AR[Build possibleColumnMatches list]
    AH --> AS[Build columnsOnlyInA and columnsOnlyInB]

    AN --> AT[Calculate summary counts]
    AO --> AT
    AP --> AT
    AQ --> AT
    AR --> AT
    AS --> AT

    AT --> AU[Return CompareReport]
```

## Code Map

1. `fetchSchemaSnapshot()` in `lib/postgres.ts`
2. `compareSchemas()` in `lib/compare.ts`
3. `compareTablePair()` for table scoring
4. `getBestMatches()` for mutual best-match logic
5. `compareColumns()` and `compareColumnPair()` for column matching
6. `compareConstraints()` for PK, unique, FK, check, and exclude differences
7. `compareMatchedTables()` for building the final per-table result

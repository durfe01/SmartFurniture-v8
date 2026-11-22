---
name: smartfurniture-uml-architecture
description: >-
  Maintains strict synchronization between src/types/contracts.ts, the modular
  src/ codebase, and the 5 Mermaid UML diagrams in docs/architecture/. Activate
  whenever adding or modifying domain types, refactoring core/UI modules,
  changing App or VectorCanvas state machines, or auditing UML and Mermaid
  hygiene in SmartFurniture v8.0.
---

# SmartFurniture UML Architecture Synchronization (v8.0)

## 1. Source-to-UML Mapping Matrix
Every structural code change MUST update its corresponding UML artifact in [`docs/architecture/`](../../../docs/architecture/README.md):

| Code Area Modified | Required UML Diagram(s) to Update |
|---|---|
| New or moved module in `src/core/`, `src/components/`, or `public/` | [`docs/architecture/01-components.md`](../../../docs/architecture/01-components.md) (component graph + DAG boundary table) |
| Any exported type, union, or field in `src/types/contracts.ts` or `costEstimator.ts` | [`docs/architecture/02-domain-classes.md`](../../../docs/architecture/02-domain-classes.md) (100 % interface coverage) |
| Pipeline invocation order (homography, vision, mathEngine, cuttingStock, exporters) | [`docs/architecture/03-sequence-pipeline.md`](../../../docs/architecture/03-sequence-pipeline.md) |
| `App.tsx` steps/flags or `VectorCanvas` steps/subtools/Undo stack | [`docs/architecture/04-state-machines.md`](../../../docs/architecture/04-state-machines.md) |
| User entry routes (Presets, Catalog 14, Photo upload, Calibration, Export) | [`docs/architecture/05-ux-activity.md`](../../../docs/architecture/05-ux-activity.md) |

## 2. Mermaid Hygiene Standards (Zero Render Failures)
1. **Supported Diagram Types Only:** Use strictly `flowchart TD`, `flowchart LR`, `classDiagram`, `sequenceDiagram`, or `stateDiagram-v2`. Never use unsupported diagram types (e.g. Gantt, mindmap, journey).
2. **Zero HTML Tags:** Never place `<br>`, `<br/>`, `<b>`, `<i>`, or `<span>` inside Mermaid blocks.
3. **Quoted Special Labels:** In flowcharts, wrap every node label containing parentheses, brackets, slashes, or colons in double quotes: `NodeId["Label (Extra Info)"]`.
4. **Safe `classDiagram` Generics:** Use Mermaid tilde generics (`Partial~CostEstimatorConfig~`) or array notation (`BoardPiece[]`) instead of raw `<T>` angle brackets.

## 3. Synchronization Procedure
1. Diff `src/types/contracts.ts` exports against the classes and attributes listed in `02-domain-classes.md`.
2. Verify all actual folders/files in `src/` and `public/` match `01-components.md` and respect the strict acyclic DAG (`UI -> Core -> Contracts`).
3. Confirm state names and transitions in `App.tsx` and `src/components/vectorCanvas/` match `04-state-machines.md`.
4. Run the PowerShell UML hygiene and DAG audit below before completing the task.

## 4. Verification Gate (Windows PowerShell 5.1)
```powershell
# 1. Verify zero HTML tags inside docs/architecture/ Mermaid files
$umlFiles = Get-ChildItem docs\architecture -Filter *.md | Select-Object -ExpandProperty FullName
$htmlHits = Select-String -Path $umlFiles -Pattern "<br|<b\b|<i\b|<span|<div"
if ($htmlHits) { $htmlHits | Format-Table; throw "HTML tags forbidden in UML diagrams" }

# 2. Verify every exported type/interface in src/types/contracts.ts is documented in 02-domain-classes.md
$contracts = Select-String -Path src\types\contracts.ts -Pattern '^export (interface|type) (\w+)' |
  ForEach-Object { $_.Matches[0].Groups[2].Value }
$classDoc = Get-Content docs\architecture\02-domain-classes.md -Raw
$missing = $contracts | Where-Object { $classDoc -notmatch "\b$_\b" }
if ($missing) { throw "Missing contracts in 02-domain-classes.md: $($missing -join ', ')" }

# 3. Verify strict DAG: zero React/Three/component imports inside src/core/
$dagViolations = Select-String -Path (Get-ChildItem src\core -Recurse -Filter *.ts).FullName -Pattern "from ['""](react|three|@react-three|\.\./\.\./components)"
if ($dagViolations) { $dagViolations | Format-Table; throw "DAG boundary violation detected" }

Write-Host "UML Architecture & DAG Audit PASSED" -ForegroundColor Green
```

# AGENTS.md

## Project Overview

- **Game Name:** TERRA-WEAVE (テラ・ウィーブ)
- **Genre:** 2D Sandbox — Emergent Cellular Automata × Cozy Ecosystem Automation
- **Core Gameplay Pillars:**
  - **Elemental Chemistry:** Interactions between materials and environmental states.
  - **Tactile Building:** Grid-based construction with procedural visual transitions.
  - **Autonomous Sprites:** Autonomous entities that interact with the environment and contribute to the ecosystem.

## Technology Stack

- **Language / Runtime:** HTML5, CSS3, and Vanilla JavaScript or TypeScript (ES6+).
- **Styling:** Follow the styling solution already established in the repository. Use Tailwind CSS or scoped CSS only if consistent with the existing setup.
- **Rendering:** HTML5 Canvas using `CanvasRenderingContext2D` and `ImageData`, or WebGL2 fragment shaders, depending on the existing rendering architecture and performance requirements. Do not introduce a second rendering backend without a clear technical justification.
- **Audio:** Web Audio API. Generate sound effects and ambient audio procedurally; do not introduce external MP3 or WAV assets unless explicitly authorized by the project specification.
- **Data Structures:** Prefer a Structure of Arrays (SoA) layout using preallocated `TypedArray` buffers (e.g., `Uint8Array`, `Int16Array`) for large, frequently updated simulation state.
- **Backend / Persistence:** Backend-free and serverless by default. Encode shareable world states and seeds in URL parameters or text codes using Run-Length Encoding (RLE) and Base64 where appropriate. Do not introduce a backend or database unless explicitly required by the specifications.

## Development Guidelines

### 1. Follow the Implementation Roadmap

- Treat `SPEC.md` as the primary source of truth for functional requirements and the four-phase implementation roadmap.
- Use `PLAN.md` for implementation planning, priorities, and architectural decisions.
- Before implementing a feature, inspect the relevant specifications, existing code, and tests.
- Follow the prescribed phase order:
  1. **Phase 1 — MVP Engine:** Core simulation, grid mechanics, and fundamental interactions.
  2. **Phase 2 — Procedural Building & Power:** Construction mechanics, procedural transitions, and power-related systems.
  3. **Phase 3 — Sprites, AI & Audio:** Autonomous entities, behavior systems, and procedural audio.
  4. **Phase 4 — Game Modes & UGC:** Additional game modes and user-generated content features.
- Do not implement features from later phases ahead of schedule unless explicitly requested or required to unblock the current phase.
- If `SPEC.md`, `PLAN.md`, and the existing implementation conflict, identify the discrepancy before making changes. Do not silently redefine established requirements.

### 2. Performance and Memory Management

- Target **60 FPS** under the expected gameplay workload on supported hardware.
- Avoid unnecessary object creation, array allocations, closures, and other sources of garbage collection pressure inside frequently executed simulation and rendering loops.
- Prefer preallocated `TypedArray` buffers and reusable temporary storage for large-scale grid updates.
- Keep simulation state separate from rendering state where practical.
- Avoid redundant full-grid scans. Use chunk-based updates, dirty regions, or spatial partitioning when profiling demonstrates a measurable benefit.
- Optimize based on profiling and reproducible measurements rather than assumptions.
- Do not sacrifice simulation correctness or code maintainability for unverified micro-optimizations.

### 3. Procedural Systems and Rendering

- Implement procedural visual transitions, including auto-tiling for structures such as arches and bridges, where required by `SPEC.md`.
- Generate environmental details such as moss, vines, lighting, and ambient effects from explicit world state, environmental conditions, or deterministic procedural rules.
- Ensure procedural visuals respond consistently to changes in the underlying simulation state.
- Use deterministic generation when reproducibility, save compatibility, or seed-based world sharing requires it.
- Keep rendering effects independent of simulation state changes unless the specification explicitly requires visual effects to influence gameplay.

### 4. Testing and Verification

- After each discrete feature or meaningful code change:
  1. Run the relevant build, type-check, lint, and test commands available in the repository.
  2. Fix regressions introduced by the change.
  3. Verify affected gameplay mechanics in the browser when practical.
  4. Check console output and performance for relevant errors or regressions.
- Inspect `package.json` and existing project scripts before assuming which commands are available.
- For simulation changes, verify relevant edge cases, state transitions, and interactions between neighboring cells.
- For rendering changes, verify visual correctness at representative grid sizes and zoom levels.
- For audio changes, verify playback behavior, resource cleanup, and browser audio-context restrictions.
- If a test cannot be executed, explain why and identify the remaining verification steps. Never claim a test passed unless it was actually run successfully.

### 5. Project Documentation and Decision Logs

- Keep `SPEC.md` and `PLAN.md` consistent with significant changes to requirements or implementation plans.
- Record important architectural decisions, algorithm choices, chunking strategies, and spatial partitioning changes in `.logs/` when they are useful for future development.
- Use concise, descriptive log filenames and include the date when appropriate.
- Prefer recording the rationale, alternatives considered, and consequences of a decision over duplicating implementation details already documented in the code.
- Do not create redundant logs for routine edits or overwrite existing decision records without a clear reason.

### 6. Documentation and Tooling

- Use Context7 MCP to consult current documentation when working with unfamiliar or version-sensitive APIs, particularly:
  - Canvas 2D and `ImageData`
  - WebGL2 and GLSL
  - Web Audio API
  - TypedArray performance and memory behavior
- Verify that documentation matches the versions and runtime environment used by the project.
- Do not add dependencies, build tools, or architectural abstractions unless they provide a clear benefit and are compatible with the existing setup.

### 7. Code Quality and Change Management

- Follow existing naming conventions, module boundaries, formatting rules, and error-handling patterns.
- Prefer small, incremental changes that can be tested independently.
- Avoid unrelated refactoring when implementing a specific feature.
- Preserve existing functionality unless the requested change explicitly modifies it.
- Update relevant tests and documentation when behavior, interfaces, or data formats change.
- Before finishing a task, summarize:
  - What changed.
  - Which files were affected.
  - Which verification commands were executed and their results.
  - Any known limitations, unresolved issues, or follow-up work.

## Final Principle

**Preserve the core gameplay pillars, follow the project specifications, and prioritize correct, verifiable implementation over speculative complexity.**
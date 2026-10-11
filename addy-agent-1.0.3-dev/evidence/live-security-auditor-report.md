## Security Audit Report

### Summary
- Critical: **0**
- High: **2**
- Medium: **0**
- Low: **0**
- **Verdict: NO-GO. No risks accepted.**
- Scope: only `HEAD~1..HEAD`, ending at `92fb4134b435e0dbe85b277e67d813ec36bbe083`.
- Independently inspected all three changed files and fixture context. No files modified; no remediation, commits, pushes, or deployment performed.

Severity reflects the demonstrated local vulnerabilities and conditional downstream impact—not an established remote compromise.

### Threat Model

The [fixture declaration](<README.md#L3-L9>) establishes untrusted caller input, but explicitly excludes deployments, credentials, network, and real users.

**Assets:** Node process integrity and availability; query integrity. Production secrets, personal data, and database contents are hypothetical downstream assets.

| Trust boundary | STRIDE assessment |
|---|---|
| Untrusted `value` → Node evaluator | **Tampering/Elevation:** caller supplies executable code with process privileges. **Disclosure:** runtime information access demonstrated. **DoS:** nonterminating code is possible, not executed. **Spoofing/Repudiation:** identity and audit infrastructure absent; not assessed as deployed defects. |
| Untrusted `userId` → SQL query text | **Tampering:** caller controls SQL syntax. **Disclosure/Elevation:** expanded database access conditional on query execution and database permissions. **DoS:** database workload abuse conditional on execution. **Spoofing/Repudiation:** authentication and audit infrastructure absent. |

### Findings

#### [HIGH] Untrusted input evaluated as JavaScript
- **Location:** [api.mjs:1](<api.mjs#L1>)
- **Description:** Numeric conversion was replaced with direct `eval(value)`. Caller-controlled strings become executable JavaScript rather than data.
- **Proven impact:** A benign input accessed the Node runtime through `globalThis.process.version`, returning `v24.15.0`.
- **Conditional impact:** If exposed through a reachable API, callers could execute code with the hosting process’s privileges, access available secrets, alter application state, or block its event loop. No remote endpoint, secret theft, or host compromise was demonstrated.
- **Proof of concept:**
  ```js
  compute('globalThis.process.version')
  ```
- **Mapping:** OWASP A03:2021 Injection; CWE-95.
- **Recommendation:** Remove evaluation, restore numeric conversion, and validate accepted types and numeric semantics explicitly:
  ```js
  export function compute(value) {
    if (typeof value !== 'string' && typeof value !== 'number')
      throw new TypeError('Invalid numeric input');
    const result = Number(value);
    if (!Number.isFinite(result))
      throw new TypeError('Invalid numeric input');
    return result;
  }
  ```
  Define blank-string and range behavior according to the intended contract. Add regression tests ensuring expression strings cannot execute.

#### [HIGH] SQL parameter binding replaced by string interpolation
- **Location:** [api.mjs:2](<api.mjs#L2>)
- **Description:** `userId` is interpolated between SQL quotes, while `parameters` is empty. The previous placeholder-based separation of SQL and data was removed.
- **Proven impact:** Input `' OR 1=1 -- ` produced:
  ```json
  {"query":"SELECT id FROM users WHERE id = '' OR 1=1 -- '","parameters":[]}
  ```
  Caller input changes the generated SQL structure.
- **Conditional impact:** If a compatible SQL engine executes this query, the predicate can match all users rather than the requested identifier. Actual data disclosure requires a database consumer; none exists in the reviewed fixture. Stacked statements, writes, and full database compromise were not verified.
- **Proof of concept:**
  ```js
  lookup("' OR 1=1 -- ")
  ```
- **Mapping:** OWASP A03:2021 Injection; CWE-89.
- **Recommendation:** Restore bound parameters and ensure any downstream database adapter actually binds them:
  ```js
  export function lookup(userId) {
    return {
      query: 'SELECT id FROM users WHERE id = ?',
      parameters: [userId]
    };
  }
  ```
  Add tests asserting both constant query text and preservation of the complete payload in `parameters`.

### Verification Results

**Runtime:** Node `v24.15.0`.

`node --test api.test.mjs` completed with **exit code 1**:
- Tests: **2**
- Passed: **0**
- Failed: **2**
- Skipped/cancelled: **0**

| Evidence | Actual failure |
|---|---|
| [api.test.mjs:4](<api.test.mjs#L4>) | `compute('2')` returns `2`; changed expectation is `3`. This failure is an incorrect expectation, not proof that numeric input returns the wrong value. |
| [api.test.mjs:5](<api.test.mjs#L5>) | Actual query is `SELECT id FROM users WHERE id = 'a'`; expected query retains `?`. This directly detects the parameterization regression. |

The separate benign exploit probes completed with **exit code 0** and demonstrated both findings. No database statements were executed.

An initial combined test/probe invocation returned exit 1 without diagnostic output and was inconclusive; the isolated test execution and corrected probe invocation above supplied usable evidence. Final `git status --short` was empty.

### OWASP / Control Review

| Category | Scoped assessment |
|---|---|
| A01 Broken Access Control | No endpoint, ownership policy, or tenant model; IDOR and deployed authorization cannot be verified. |
| A02 Cryptographic Failures | No credentials, encryption, or sensitive storage in scoped files. |
| A03 Injection | Two findings above. |
| A04 Insecure Design | Untrusted inputs cross executable-code and SQL boundaries without separation; covered by findings rather than double-counted. |
| A05 Security Misconfiguration | HTTPS, headers, CORS, service permissions, and deployment configuration absent; not verified. |
| A06 Vulnerable Components | No dependency additions, manifest, or lockfile in the three-file fixture. See dependency limitation below. |
| A07 Authentication Failures | No login, password hashing, sessions, reset tokens, or authentication middleware. No claim of verified authentication safety. |
| A08 Software/Data Integrity | No updater, package installation, or signature-validation integration in scope. |
| A09 Logging/Monitoring | Infrastructure absent by fixture declaration; no deployed logging assessment possible. |
| A10 SSRF | No server-side fetch or URL integration in scoped code. |

**Secrets:** No hardcoded secrets or credential material found in the scoped diff and complete fixture files. This is not an audit of earlier history or the enclosing workspace.

**Dependencies/supply chain:** Tracked fixture inventory contains only the three reviewed files. Test imports use Node built-ins and the local helper. No package additions, typosquat candidates, postinstall scripts, or committed dependency graph were present to audit. A package-manager CVE audit was therefore not applicable to this scope; Node advisory status and enclosing-workspace dependencies remain unverified.

**AI/LLM:** No AI integration is present. The LLM Top 10 is not applicable to the demonstrated fixture. Feeding model output into these helpers would introduce conditional LLM05:2025 Improper Output Handling exposure, but that integration was not observed.

### Positive Observations
- The unchanged query test detects loss of parameterization.
- The [documentation](<README.md#L7-L9>) explicitly identifies the synthetic unsafe change and avoids claiming deployed infrastructure.
- The previous implementation separated SQL text from caller data.
- Tests run without installing external packages.

### Recommendations
1. Block approval until both injection paths are removed.
2. Correct the numeric test expectation and require the complete suite to pass.
3. Add adversarial expression and SQL-payload tests, including parameter-array assertions.
4. If integrated into a real service, separately verify authentication, resource authorization, database privileges, rate limits, and deployment controls.

**Limitations:** This is the independently produced security-auditor report only; it does not substitute for the code reviewer’s five-axis report or the test engineer’s full coverage report. No nested delegation occurred.
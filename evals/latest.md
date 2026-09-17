# Eval report

- **Result:** pass
- **Run at:** 2026-09-17T19:16:14.315Z
- **Commit:** acdbcec40fb7d7a7656ed97b45d1960ed2c5da4f

## Prompts

- `constraint-extraction`: extract-constraints v5 on claude-haiku-4-5

## constraint-extraction — pass (17 fixtures)

| Metric | Value | Threshold | Result |
|---|---|---|---|
| exclude_exact | 1 | 1 | pass |
| avoid_f1 | 1 | 0.8 | pass |
| have_f1 | 1 | 0.8 | pass |
| max_minutes_exact | 1 | 0.8 | pass |

```json
{
  "runAt": "2026-09-17T19:16:14.315Z",
  "gitSha": "acdbcec40fb7d7a7656ed97b45d1960ed2c5da4f",
  "passed": true,
  "suites": [
    {
      "name": "constraint-extraction",
      "prompt": {
        "name": "extract-constraints",
        "version": "5"
      },
      "model": "claude-haiku-4-5",
      "fixtures": 17,
      "passed": true,
      "metrics": [
        {
          "name": "exclude_exact",
          "value": 1,
          "threshold": 1,
          "passed": true
        },
        {
          "name": "avoid_f1",
          "value": 1,
          "threshold": 0.8,
          "passed": true
        },
        {
          "name": "have_f1",
          "value": 1,
          "threshold": 0.8,
          "passed": true
        },
        {
          "name": "max_minutes_exact",
          "value": 1,
          "threshold": 0.8,
          "passed": true
        }
      ]
    }
  ]
}
```

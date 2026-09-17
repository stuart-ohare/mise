# Eval report

- **Result:** pass
- **Run at:** 2026-09-17T17:33:04.745Z
- **Commit:** 0b42d4eb519f1443788e72e20fcdae989b3af62f

## Prompts

- `constraint-extraction`: extract-constraints v4 on claude-haiku-4-5

## constraint-extraction — pass (15 fixtures)

| Metric | Value | Threshold | Result |
|---|---|---|---|
| exclude_exact | 1 | 1 | pass |
| avoid_f1 | 1 | 0.8 | pass |
| have_f1 | 1 | 0.8 | pass |
| max_minutes_exact | 1 | 0.8 | pass |

```json
{
  "runAt": "2026-09-17T17:33:04.745Z",
  "gitSha": "0b42d4eb519f1443788e72e20fcdae989b3af62f",
  "passed": true,
  "suites": [
    {
      "name": "constraint-extraction",
      "prompt": {
        "name": "extract-constraints",
        "version": "4"
      },
      "model": "claude-haiku-4-5",
      "fixtures": 15,
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

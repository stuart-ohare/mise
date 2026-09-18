# Eval report

- **Result:** pass
- **Run at:** 2026-09-18T00:02:14.708Z
- **Commit:** b191a835a61ec1c4d4b17e9368d727253d5ade3e

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
  "runAt": "2026-09-18T00:02:14.708Z",
  "gitSha": "b191a835a61ec1c4d4b17e9368d727253d5ade3e",
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

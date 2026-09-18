# Eval report

- **Result:** pass
- **Run at:** 2026-09-18T08:40:53.610Z
- **Commit:** 90d257ab9380e84a961ee5a36c365227e869ecb7

## Prompts

- `constraint-extraction`: extract-constraints v5 on claude-haiku-4-5
- `recipe-extraction`: extract-recipe v1 on claude-sonnet-4-5

## constraint-extraction — pass (17 fixtures)

| Metric | Value | Threshold | Result |
|---|---|---|---|
| exclude_exact | 1 | 1 | pass |
| avoid_f1 | 1 | 0.8 | pass |
| have_f1 | 1 | 0.8 | pass |
| max_minutes_exact | 1 | 0.8 | pass |

## recipe-extraction — pass (6 fixtures)

| Metric | Value | Threshold | Result |
|---|---|---|---|
| field_accuracy | 1 | 0.85 | pass |
| null_precision | 1 | 1 | pass |

```json
{
  "runAt": "2026-09-18T08:40:53.610Z",
  "gitSha": "90d257ab9380e84a961ee5a36c365227e869ecb7",
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
    },
    {
      "name": "recipe-extraction",
      "prompt": {
        "name": "extract-recipe",
        "version": "1"
      },
      "model": "claude-sonnet-4-5",
      "fixtures": 6,
      "passed": true,
      "metrics": [
        {
          "name": "field_accuracy",
          "value": 1,
          "threshold": 0.85,
          "passed": true
        },
        {
          "name": "null_precision",
          "value": 1,
          "threshold": 1,
          "passed": true
        }
      ]
    }
  ]
}
```

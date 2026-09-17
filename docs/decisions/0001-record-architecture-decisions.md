# 1. Record architecture decisions

**Status:** accepted
**Date:** 2026-09-17

## Context

This project is small and short-lived, and it will be read by people deciding whether
the person who wrote it makes good decisions. The code shows *what* was decided. It
does not show what the alternative was, or why it lost.

## Decision

Every decision worth defending in a review gets a numbered file here. One page, four
headings: context, decision, the alternative and why it lost, and the cost being
accepted.

The bar is "would I have to explain this in a technical review" — not every choice.
A decision with no live alternative isn't a decision, it's a default.

## Alternative considered

Keeping the reasoning in the README. Rejected because the README is a document for
someone deciding whether to run the project, and mixing five paragraphs of rationale
into it makes it worse at that job. The README links here instead.

## Cost accepted

A second place to keep writing current. Mitigated by the bar above — this directory
should stay small.

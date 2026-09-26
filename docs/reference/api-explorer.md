---
title: API explorer
description: Every operation of the NextExplorer API, from its OpenAPI description.
aside: false
outline: false
---

# Every operation

This page reads [`openapi.json`](/openapi.json), the API's OpenAPI 3.1
description — the same one a running instance serves at `/api/openapi.json`,
for the release it runs. Point a generated client or an API tool at either.

The description is written by hand and held to the application by its tests:
every route the server mounts is in it and nothing else is, who may call each
operation agrees with the checks that enforce it, and every answer shape was
checked against what the server really answered. [Driving NextExplorer from
the API](/reference/api) is where the examples are.

<ApiExplorer />

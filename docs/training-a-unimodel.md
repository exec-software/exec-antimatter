# Model training research

Antimatter is an inference client and coding workspace. It does not ship a model-training
pipeline, a training dataset, or a fine-tuned checkpoint. Experimental inference support must
not be presented as evidence that a training workload is implemented or qualified.

## Scope of a future proposal

A separately reviewed training proposal should identify:

- the exact base-model revision and applicable license;
- the origin, permissions, retention rules, and evaluation split for every dataset;
- the training method, precision, optimizer, and reproducible software versions;
- measured memory, storage, transfer, and step-time requirements on the proposed hardware;
- a bounded pilot and explicit quality, correctness, and safety acceptance criteria;
- the provenance and distribution requirements for any resulting weights.

Do not publish private datasets, internal deployment topology, unpublished product plans, or
credentials as part of a research note. Capacity estimates are not measurements, and a
successful inference test does not validate training throughput or model quality.

This page is a project-scope statement, not a commitment to a training architecture, schedule,
hardware purchase, or future hosted service.

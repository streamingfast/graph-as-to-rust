## The Graph AssemblyScript to Rust

This project contains an AssemblyScript compiler's transformer that reads the `graph-ts` source files
and generates Rust bindings for them.

For now, the project is mostly in a rough state but working state. It generates the binding for `near`
namespace only hard-coding the namespace read as well as the output file.

### Run

Ensure that `graph-ts` is a sibling project of this one, you should have under the same folder
the two project (e.g. `graph-ts` and `graph-as-to-rust`) like so:

```
.
├── graph-as-to-rust
└── graph-ts
```

You can do the following.

In your first terminal, do:

```
yarn tsc --watch
```

In the second terminal, do:

```
node run.js
```

This will copy AssemblyScript files from `graph-ts` into a temporary folder inside the project,
then will launch `asc` compiler with the correct transformer and generates a `near.rs` with all the
NEAR Rust bindings for The Graph.

> You can add `DEBUG="*"` in front of the `node run.js` command to activate debug logs and show more logging.

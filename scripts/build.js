#!/usr/bin/node

const start = Date.now()

const glob = require("glob")
const fs = require("fs")
const path = require("path")

const { build } = require("esbuild")

const {
  default: TsconfigPathsPlugin,
} = require("@esbuild-plugins/tsconfig-paths")
const { nodeExternalsPlugin } = require("esbuild-node-externals")

var argv = require("minimist")(process.argv.slice(2))

function runBuild(
  entry,
  outfile,
  opts = { skipMeta: false, bundle: true, silent: false }
) {
  const isDev = process.env.NODE_ENV !== "production"
  const tsconfig = argv["p"] || `tsconfig.build.json`
  const tsconfigPathPluginContent = JSON.parse(
    fs.readFileSync(tsconfig, "utf-8")
  )

  if (
    !fs.existsSync("../pro/src") &&
    tsconfigPathPluginContent.compilerOptions?.paths
  ) {
    // If we don't have pro, we cannot bundle backend-core.
    // Otherwise, the main context will not be shared between libraries
    delete tsconfigPathPluginContent?.compilerOptions?.paths?.[
      "@budibase/backend-core"
    ]
    delete tsconfigPathPluginContent?.compilerOptions?.paths?.[
      "@budibase/backend-core/*"
    ]
  }

  const metafile = !opts.skipMeta
  const { bundle } = opts

  const sharedConfig = {
    entryPoints: [entry],
    bundle,
    minify: !isDev,
    sourcemap: isDev,
    tsconfig,
    format: opts?.forcedFormat,
    plugins: [
      TsconfigPathsPlugin({ tsconfig: tsconfigPathPluginContent }),
      nodeExternalsPlugin(),
    ],
    preserveSymlinks: true,
    loader: {
      ".svelte": "copy",
    },
    metafile,
    external: bundle
      ? ["deasync", "mock-aws-s3", "nock", "pino", "koa-pino-logger", "bull"]
      : undefined,
  }

  build({
    ...sharedConfig,
    platform: "node",
    outfile,
  }).then(result => {
    glob(`${process.cwd()}/src/**/*.hbs`, {}, (err, files) => {
      for (const file of files) {
        fs.copyFileSync(file, `${process.cwd()}/dist/${path.basename(file)}`)
      }

      !opts.silent &&
        console.log(
          "\x1b[32m%s\x1b[0m",
          `Build successfully in ${(Date.now() - start) / 1000} seconds`
        )
    })

    if (metafile) {
      fs.writeFileSync(
        `dist/${path.basename(outfile)}.meta.json`,
        JSON.stringify(result.metafile)
      )
    }
  })
}

if (require.main === module) {
  const entry = argv["e"] || "./src/index.ts"
  const outfile = `dist/${entry.split("/").pop().replace(".ts", ".js")}`
  runBuild(entry, outfile)
} else {
  module.exports = runBuild
}

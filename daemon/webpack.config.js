const path = require("path");
const nodeExternals = require("webpack-node-externals");

/**
 * @type {import('webpack').Configuration}
 */
module.exports = {
  mode: "production",
  entry: {
    app: "./src/app.ts",
    proc_scan_worker: "./src/service/supervisor/proc_scan_worker.ts"
  },
  module: {
    rules: [
      {
        test: /\.ts/,
        use: "ts-loader",
        exclude: /node_modules/
      }
    ]
  },
  target: "node",
  devtool: "source-map",
  optimization: {
    chunkIds: "named",
    minimize: false,
    mangleExports: false,
    moduleIds: "named"
  },
  externalsPresets: { node: true },
  externals: [
    nodeExternals({
      allowlist: ["mcsmanager-common"]
    })
  ],
  output: {
    filename: "[name].js",
    path: path.resolve(__dirname, "production")
  },
  resolve: {
    extensions: [".ts", ".js"],
    alias: {
      "@languages": path.resolve(__dirname, "../languages"),
      "mcsmanager-common": path.resolve(__dirname, "../common/src/index.ts")
    }
  }
};

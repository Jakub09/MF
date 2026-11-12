// Minimalny build pluginu: jeden moduł AMD (tak ładuje go Grafana),
// biblioteki dostarczane przez Grafanę są "externals".
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (_env, argv) => ({
  entry: './src/module.ts',
  devtool: argv.mode === 'production' ? 'source-map' : 'eval-source-map',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'module.js',
    library: { type: 'amd' },
    publicPath: '/public/plugins/mainframe-dasdmap-panel/',
    clean: true,
  },
  externals: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    '@grafana/data',
    '@grafana/ui',
    '@grafana/runtime',
    '@emotion/css',
    '@emotion/react',
    'lodash',
    'rxjs',
  ],
  resolve: { extensions: ['.ts', '.tsx', '.js'] },
  module: {
    rules: [{ test: /\.tsx?$/, loader: 'ts-loader', options: { transpileOnly: true }, exclude: /node_modules/ }],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'src/plugin.json', to: '.' },
        { from: 'src/img', to: 'img' },
        { from: 'README.md', to: '.' },
      ],
    }),
  ],
});

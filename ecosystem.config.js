module.exports = {
  apps: [
    {
      name: "jamly",
      script: "./server.js",
      cwd: "/var/www/jamly/current",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      }
    }
  ]
};

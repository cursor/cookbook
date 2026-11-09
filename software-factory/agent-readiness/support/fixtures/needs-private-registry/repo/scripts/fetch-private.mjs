if (!process.env.NPM_TOKEN) {
  console.error("npm error code E401");
  console.error("npm error 401 Unauthorized - GET https://registry.example.invalid/@acme%2fdesign-tokens - authentication token not provided");
  process.exit(1);
}
console.log("fetched @acme/design-tokens from the private registry");

exports.handler = async function (event, context) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/plain" },
    body: "Hello from Netlify Functions! If you see this text, functions are working on your site."
  };
};

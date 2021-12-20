# Testing

To test the functionality this library, the port that the solid community server uses has to be extended to the environment file
The `.env` file then becomes.

```text
SOLID_IDP=https://broker.pod.inrupt.com
PORT=3050
```

When this file is set, jest can be executed to verify that the code works as intended:

```bash
npm run test
```

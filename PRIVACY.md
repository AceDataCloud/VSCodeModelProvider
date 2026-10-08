# Privacy

This extension stores the Ace Data Cloud application API key in VS Code SecretStorage and model IDs and token limits in VS Code global state. It sends the key, chat messages, and selected tool definitions and results only to `https://api.acedata.cloud`. It does not run tools itself, send telemetry, or retry requests automatically.

Ace Data Cloud API usage is subject to your account settings and current pricing. Remove the saved key with **Ace Data Cloud: Manage Chat Models → Clear saved API key**. For support, open an [issue](https://github.com/AceDataCloud/VSCodeModelProvider/issues) without including credentials, prompts, or private response content.

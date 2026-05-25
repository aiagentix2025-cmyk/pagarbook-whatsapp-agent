const openAiApiKeyDefault = process.env.OPENAI_API_KEY;
const groqApiKeyDefault = process.env.GROQ_API_KEY;

// Unified Chat Completion Helper
async function getChatCompletion({
  messages,
  model = 'gpt-4o-mini',
  temperature = 0.3,
  openAiApiKey,
  groqApiKey,
  hasImage = false
}) {
  const isGroq = model.startsWith('llama') || model.startsWith('mixtral') || model.startsWith('gemma');
  
  // Force OpenAI if we have image inputs, as Groq lacks reliable vision APIs in standard endpoints
  if (hasImage || !isGroq) {
    const apiKey = openAiApiKey || openAiApiKeyDefault;
    if (!apiKey) {
      throw new Error('OpenAI API key is missing. Required for vision and default text models.');
    }

    console.log(`Routing completion request to OpenAI (${model}, vision=${hasImage})...`);
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: hasImage ? 'gpt-4o-mini' : model,
        messages: messages,
        temperature: temperature
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI Chat completion error: ${response.status} - ${errText}`);
    }

    const result = await response.json();
    return result.choices[0].message.content;
  } else {
    // Route to Groq
    const apiKey = groqApiKey || groqApiKeyDefault;
    if (!apiKey) {
      throw new Error(`Groq API key is missing. Required for model ${model}.`);
    }

    console.log(`Routing completion request to Groq (${model})...`);
    const response = await fetch('https://api.groq.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: temperature
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq Chat completion error: ${response.status} - ${errText}`);
    }

    const result = await response.json();
    return result.choices[0].message.content;
  }
}

module.exports = {
  getChatCompletion,
};

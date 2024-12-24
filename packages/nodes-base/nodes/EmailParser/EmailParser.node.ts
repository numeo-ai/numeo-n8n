import type {
	IExecuteFunctions,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
	INodeExecutionData,
	IDataObject,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';

interface IEmailParserResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
}

interface IOrderDetails extends IDataObject {
	pickup: {
		date: string | null;
		time: string | null;
	};
	delivery: {
		date: string | null;
		time: string | null;
	};
	contact: {
		name: string;
		email: string;
		phone: string;
		company: string | null;
	};
	cargo: {
		cargoType: string | null;
		specialRequirements: string[] | null;
	};
	recommendedPricePerMile: number;
}

export class EmailParser implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Email Parser',
		name: 'emailParser',
		icon: 'file:emailParser.svg',
		group: ['transform'],
		version: 1,
		description: 'Parses email content using OpenAI to extract order details',
		defaults: {
			name: 'Email Parser',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: 'openAiApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Subject',
				name: 'subject',
				type: 'string',
				default: '',
				description: 'The subject of the email to parse',
				required: true,
			},
			{
				displayName: 'Body',
				name: 'body',
				type: 'string',
				default: '',
				description: 'The body content of the email to parse',
				required: true,
				typeOptions: {
					rows: 4,
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('openAiApi');

		for (let i = 0; i < items.length; i++) {
			try {
				const subject = this.getNodeParameter('subject', i) as string;
				const body = this.getNodeParameter('body', i) as string;

				// Prepare the prompt
				const messages = [
					{
						role: 'system',
						content:
							'You are a helpful assistant that extracts shipping order details from emails. Always return valid JSON.',
					},
					{
						role: 'user',
						content: `Extract shipping order details from this email:
Subject: ${subject}
Body: ${body}

Please extract and return ONLY a JSON object with this exact structure (use null for missing values):
{
    "pickup": {
        "date": string | null,
        "time": string | null
    },
    "delivery": {
        "date": string | null,
        "time": string | null
    },
    "contact": {
        "name": string,
        "email": string,
        "phone": string,
        "company": string | null
    },
    "cargo": {
        "cargoType": string | null,
        "specialRequirements": string[] | null
    },
    "recommendedPricePerMile": number
}`,
					},
				];

				// Make request to OpenAI API
				const options: IHttpRequestOptions = {
					method: 'POST',
					url: 'https://api.openai.com/v1/chat/completions',
					headers: {
						Authorization: `Bearer ${credentials.apiKey as string}`,
						'Content-Type': 'application/json',
					},
					body: {
						model: 'gpt-4',
						messages,
						temperature: 0.3,
					},
				};

				const response = (await this.helpers.httpRequest(options)) as IEmailParserResponse;

				if (!response.choices?.[0]?.message?.content) {
					throw new NodeOperationError(this.getNode(), 'No valid response from OpenAI');
				}

				// Parse the response
				const parsedData = JSON.parse(response.choices[0].message.content) as IOrderDetails;

				// // Validate required fields
				if (!parsedData.contact?.name || !parsedData.contact?.email || !parsedData.contact?.phone) {
					throw new NodeOperationError(
						this.getNode(),
						'Missing required contact information in the parsed data',
					);
				}

				// Add the parsed data to the output
				const executionData: INodeExecutionData = {
					json: parsedData,
					pairedItem: {
						item: i,
					},
				};

				returnData.push(executionData);
			} catch (error) {
				if (error.response) {
					throw new NodeOperationError(
						this.getNode(),
						`OpenAI API Error: ${error.response.data?.error?.message || error.message}`,
						{
							itemIndex: i,
						},
					);
				}
				throw error;
			}
		}

		return [returnData];
	}
}

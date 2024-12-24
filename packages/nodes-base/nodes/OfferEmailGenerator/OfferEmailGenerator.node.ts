import type {
	IExecuteFunctions,
	INodeType,
	INodeTypeDescription,
	INodeExecutionData,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';

interface IRouteDetails {
	pickup: {
		address: string;
		city: string;
		state: string;
		date: string;
		time: string;
		postalCode: string;
	};
	delivery: {
		address: string;
		city: string;
		state: string;
		date: string;
		time: string;
		postalCode: string;
	};
	contact: {
		name: string;
		email: string;
		phone: string;
		company: string;
	};
	cargo: {
		cargoType: string;
		specialRequirements?: string[];
	};
	tollInfo?: {
		driverCost: number;
		fuelCost: number;
	};
	miles: number;
	duration: number;
	badRouteConditions?: string[];
}

export class OfferEmailGenerator implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Offer Email Generator',
		name: 'offerEmailGenerator',
		icon: 'file:offerEmailGenerator.svg',
		group: ['transform'],
		version: 1,
		description: 'Generates offer emails based on route details',
		defaults: {
			name: 'Offer Email Generator',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: 'Details',
				name: 'details',
				type: 'json',
				default: '',
				description: 'Route details in JSON format',
				required: true,
				typeOptions: {
					alwaysOpenEditWindow: true,
				},
			},
			{
				displayName: 'Email ID',
				name: 'emailId',
				type: 'string',
				default: '',
				description: 'Original email ID to reference in the reply',
				required: true,
			},
			{
				displayName: 'Email Subject Prefix',
				name: 'subjectPrefix',
				type: 'string',
				default: 'RE:',
				description: 'Prefix to add to the email subject',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const detailsJson = this.getNodeParameter('details', i);
				const details = detailsJson as IRouteDetails;
				const emailId = this.getNodeParameter('emailId', i) as string;
				const subjectPrefix = this.getNodeParameter('subjectPrefix', i) as string;

				// Calculate total cost
				const totalCostPerMile =
					(details.tollInfo?.driverCost ?? 0) + (details.tollInfo?.fuelCost ?? 0);
				const totalCost = Math.round(totalCostPerMile * (details?.miles ?? 0));

				// Format dates
				const pickupDate = new Date(details.pickup.date).toLocaleDateString('en-US', {
					month: 'numeric',
					day: 'numeric',
					year: '2-digit',
				});

				// Generate email using template
				const emailBody = `Hi ${details.contact.name},

We can have a truck in ${details.pickup.city}, ${details.pickup.state} picking up on ${pickupDate}
for $${totalCost}.

Rate: $${totalCost}
Origin: ${details.pickup.city}, ${details.pickup.state}
Destination: ${details.delivery.city}, ${details.delivery.state}
Equipment: ${details.cargo.cargoType}

Please confirm to get this booked.
Thanks!`;

				// Add the generated email to the output
				const executionData: INodeExecutionData = {
					json: {
						subject: `${subjectPrefix} ${emailId}`,
						body: emailBody,
					},
				};

				returnData.push(executionData);
			} catch (error) {
				throw new NodeOperationError(this.getNode(), `Error generating email: ${error.message}`, {
					itemIndex: i,
				});
			}
		}

		return [returnData];
	}
}

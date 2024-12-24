import type {
	IExecuteFunctions,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
	INodeExecutionData,
	// IDataObject,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';

export class RouteManager implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Route Manager',
		name: 'routeManager',
		icon: 'file:routemanager.svg',
		group: ['transform'],
		version: 1,
		description: 'Generates truck routes and collects data',
		defaults: {
			name: 'Route Manager',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: 'openAiApi',
				required: true,
			},
			{
				name: 'hereApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Pickup Location',
				name: 'pickupLocation',
				type: 'string',
				default: '',
				placeholder: 'Enter pickup location',
				required: true,
			},
			{
				displayName: 'Destination Location',
				name: 'destinationLocation',
				type: 'string',
				default: '',
				placeholder: 'Enter destination location',
				required: true,
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentialsOpenAI = await this.getCredentials('openAiApi');
		const credentialsHere = await this.getCredentials('hereApi');

		for (let i = 0; i < items.length; i++) {
			try {
				const pickupLocation = this.getNodeParameter('pickupLocation', i) as string;
				const destinationLocation = this.getNodeParameter('destinationLocation', i) as string;

				// Generate routes
				const routeOptions: IHttpRequestOptions = {
					method: 'GET',
					url: `https://router.hereapi.com/v8/routes?origin=${pickupLocation}&destination=${destinationLocation}&apiKey=${this.apiKey}`,
				};
				const routesResponse = await this.helpers.httpRequest(routeOptions);
				const routes = routesResponse.routes;

				// Collect weather data
				const weatherData = await Promise.all(
					routes.map(async (route: { location: any }) => {
						const weatherOptions: IHttpRequestOptions = {
							method: 'GET',
							url: `https://api.openai.com/v1/weather?location=${route.location}`,
						};
						try {
							const response = await this.helpers.httpRequest(weatherOptions);
							return response.data;
						} catch (error) {
							throw new NodeOperationError(
								this.getNode(),
								`Error fetching weather data: ${error.message}`,
							);
						}
					}),
				);

				// Collect elevation data
				const elevationData = await Promise.all(
					routes.map(async (route: { location: any }) => {
						const elevationOptions: IHttpRequestOptions = {
							method: 'GET',
							url: `https://api.here.com/v8/elevation?location=${route.location}`,
						};
						try {
							const response = await this.helpers.httpRequest(elevationOptions);
							return response.data;
						} catch (error) {
							throw new NodeOperationError(
								this.getNode(),
								`Error fetching elevation data: ${error.message}`,
							);
						}
					}),
				);

				// Calculate tolls
				const tollData = await Promise.all(
					routes.map(async (route: { id: any }) => {
						const tollOptions: IHttpRequestOptions = {
							method: 'GET',
							url: `https://api.here.com/v8/tolls?routeId=${route.id}`,
						};
						try {
							const response = await this.helpers.httpRequest(tollOptions);
							return response.data;
						} catch (error) {
							throw new NodeOperationError(
								this.getNode(),
								`Error calculating tolls: ${error.message}`,
							);
						}
					}),
				);

				// Process and prepare the output
				const rankedRoutes = routes
					.map((route: any, index: number) => ({
						...route,
						weather: weatherData[index],
						elevation: elevationData[index],
						toll: tollData[index],
					}))
					.sort((a: { toll: number }, b: { toll: number }) => a.toll - b.toll);

				returnData.push({ json: processedData });
			} catch (error) {
				throw new NodeOperationError(
					this.getNode(),
					`Error processing item ${i}: ${error.message}`,
				);
			}
		}

		return [returnData];
	}
}

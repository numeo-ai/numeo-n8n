import type {
	IExecuteFunctions,
	INodeType,
	INodeTypeDescription,
	IHttpRequestOptions,
	INodeExecutionData,
	IDataObject,
} from 'n8n-workflow';
import { NodeConnectionType, ApplicationError } from 'n8n-workflow';

interface Location {
	address: string;
	city: string;
	state: string;
	date: string;
	time: string;
	postalCode: string;
}

interface Contact {
	name: string;
	email: string;
	phone: string;
	company: string;
}

interface Cargo {
	cargoType: string;
	specialRequirements: string[];
}

interface RouteDetails {
	pickup: Location;
	delivery: Location;
	contact: Contact;
	cargo: Cargo;
}

interface Route {
	tollInfo: {
		driverCost: number;
		fuelCost: number;
	};
	miles: number;
	duration: number;
	badRouteConditions: string[];
	score?: number;
	rank?: number;
}

interface OutputData extends IDataObject {
	details: RouteDetails;
	routes: Route[];
	emailId: string;
}

// Helper function to parse address into components
async function parseAddress(address: string, hereApiKey: string): Promise<Location> {
	try {
		const geocodeResponse = await fetch(
			`https://geocode.search.hereapi.com/v1/geocode?q=${encodeURIComponent(address)}&apiKey=${hereApiKey}`,
		);
		const geocodeData = await geocodeResponse.json();

		// if (!geocodeData.items?.[0]) {
		// 	throw new Error(`Unable to geocode address: ${address}`);
		// }

		const result = geocodeData.items[0];
		return {
			address: result.address.label,
			city: result.address.city,
			state: result.address.state,
			postalCode: result.address.postalCode,
			date: '', // Will be filled from input data
			time: '', // Will be filled from input data
		};
	} catch (error) {
		throw new ApplicationError('Error parsing address', { cause: error });
	}
}

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
			{
				name: 'googleApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Input Data',
				name: 'inputData',
				type: 'json',
				default: '',
				description: 'Order details in JSON format',
				required: true,
			},
		],
	};

	// Static method to calculate route score based on various factors
	static calculateRouteScore(route: Route): number {
		const durationWeight = 0.4; // 40% weight for duration
		const milesWeight = 0.3; // 30% weight for distance
		const conditionsWeight = 0.3; // 30% weight for route conditions

		// Normalize duration (assuming max reasonable duration is 12 hours)
		const durationScore = Math.max(0, 1 - route.duration / 12);

		// Normalize miles (assuming max reasonable distance is 800 miles)
		const milesScore = Math.max(0, 1 - route.miles / 800);

		// Calculate conditions score (more bad conditions = lower score)
		const conditionsScore = Math.max(0, 1 - route.badRouteConditions.length * 0.2);

		// Calculate weighted score
		return (
			durationScore * durationWeight + milesScore * milesWeight + conditionsScore * conditionsWeight
		);
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentialsOpenAI = await this.getCredentials('openAiApi');
		const credentialsHere = await this.getCredentials('hereApi');
		// const credentialsGoogle = await this.getCredentials('googleApi');

		// Helper function to fetch elevation data
		const fetchElevationData = async (
			points: Array<{ lat: number; lng: number }>,
		): Promise<any[]> => {
			try {
				// HERE API accepts up to 100 points per request
				const rows = points.map((p) => `${p.lat},${p.lng}`).join(';');

				const options: IHttpRequestOptions = {
					method: 'GET',
					url: `https://terrain.ls.hereapi.com/v1/terrain?points=${rows}&apiKey=${credentialsHere.apiKey}`,
					json: true,
				};

				const response = await this.helpers.httpRequest(options);
				return response.elevations || [];
			} catch (error) {
				console.error('Error fetching elevation data:', error);
				return [];
			}
		};

		for (let i = 0; i < items.length; i++) {
			try {
				// Parse input data
				const inputJson = JSON.parse(this.getNodeParameter('inputData', i) as string);
				console.log('📦 Processing order:', inputJson.orderType);

				// Parse addresses
				const [pickupLocation, deliveryLocation] = await Promise.all([
					parseAddress(inputJson.pickup.location, credentialsHere.apiKey as string),
					parseAddress(inputJson.delivery.location, credentialsHere.apiKey as string),
				]);

				// Add dates and times from input
				pickupLocation.date = inputJson.pickup.date;
				pickupLocation.time = inputJson.pickup.time;
				deliveryLocation.date = inputJson.delivery.date;
				deliveryLocation.time = inputJson.delivery.time;

				// Generate routes
				const routeOptions: IHttpRequestOptions = {
					method: 'GET',
					url: `https://router.hereapi.com/v8/routes?transportMode=truck&origin=${encodeURIComponent(pickupLocation.address)}&destination=${encodeURIComponent(deliveryLocation.address)}&return=polyline,turnByTurnActions,actions,instructions,summary&apiKey=${credentialsHere.apiKey}`,
					json: true,
				};

				const routesResponse = await this.helpers.httpRequest(routeOptions);
				const routes = routesResponse.routes;
				console.log(`🛣️ Found ${routes.length} possible routes`);

				// Process each route
				const processedRoutes: Route[] = await Promise.all(
					routes.map(async (route: any) => {
						// Extract waypoints
						const waypoints = route.sections.flatMap((section: any) =>
							section.polyline ? RouteManager.prototype.decodePolyline(section.polyline) : [],
						);

						// Get elevation data
						const elevationData = await fetchElevationData(waypoints);

						// Get weather conditions
						const weatherPrompt = `What are the typical weather conditions for a route from ${pickupLocation.city}, ${pickupLocation.state} to ${deliveryLocation.city}, ${deliveryLocation.state} during ${pickupLocation.date}? Focus on conditions that could affect truck transportation.`;
						const weatherResponse = await this.helpers.httpRequest({
							method: 'POST',
							url: 'https://api.openai.com/v1/chat/completions',
							headers: {
								Authorization: `Bearer ${credentialsOpenAI.apiKey as string}`,
								'Content-Type': 'application/json',
							},
							body: {
								model: 'gpt-3.5-turbo',
								messages: [{ role: 'user', content: weatherPrompt }],
							},
							json: true,
						});

						// Compile route conditions
						const badRouteConditions: string[] = [];

						// Add weather conditions
						if (weatherResponse.choices[0].message.content) {
							badRouteConditions.push(weatherResponse.choices[0].message.content);
						}

						// Add elevation warnings
						const significantElevationChanges = elevationData.some(
							(elevation: any, index: number, array: any[]) =>
								index > 0 && Math.abs(elevation.elevation - array[index - 1].elevation) > 500,
						);
						if (significantElevationChanges) {
							badRouteConditions.push('Significant elevation changes along route');
						}

						return {
							tollInfo: {
								driverCost: route.sections[0].tolls?.totalCost || 0,
								fuelCost: route.sections[0].summary?.baseCost || 0,
							},
							miles: route.sections[0].summary?.length || 0,
							duration: (route.sections[0].summary?.duration || 0) / 3600,
							badRouteConditions,
						};
					}),
				);

				// Score and rank routes
				processedRoutes.forEach((route) => {
					route.score = RouteManager.calculateRouteScore(route);
				});

				processedRoutes.sort((a, b) => (b.score || 0) - (a.score || 0));
				processedRoutes.forEach((route, index) => {
					route.rank = index + 1;
				});

				// Prepare final output
				const output: OutputData = {
					details: {
						pickup: pickupLocation,
						delivery: deliveryLocation,
						contact: inputJson.contact,
						cargo: inputJson.cargo,
					},
					routes: processedRoutes,
					emailId: inputJson.contact.email,
				};

				console.log(`✅ Successfully processed ${processedRoutes.length} routes`);
				returnData.push({ json: output });
			} catch (error) {
				console.error('❌ Error processing routes:', error);
				throw new ApplicationError('Error processing routes', { cause: error });
			}
		}

		return [returnData];
	}

	// Helper function to decode polyline
	private decodePolyline(polyline: string): Array<{ lat: number; lng: number }> {
		let index = 0;
		const points: Array<{ lat: number; lng: number }> = [];
		let lat = 0;
		let lng = 0;

		while (index < polyline.length) {
			let result = 1;
			let shift = 0;
			let b: number;
			do {
				b = polyline.charCodeAt(index++) - 63 - 1;
				result += b << shift;
				shift += 5;
			} while (b >= 0x1f);
			lat += (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

			result = 1;
			shift = 0;
			do {
				b = polyline.charCodeAt(index++) - 63 - 1;
				result += b << shift;
				shift += 5;
			} while (b >= 0x1f);
			lng += (result & 1) !== 0 ? ~(result >> 1) : result >> 1;

			points.push({
				lat: lat * 1e-5,
				lng: lng * 1e-5,
			});
		}

		return points;
	}
}

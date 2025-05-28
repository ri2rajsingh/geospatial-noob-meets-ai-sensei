// Google Earth Engine code to train an ML model for brick kiln detection
// This script assumes you have a geometry collection called 'brick_kiln' with known kiln locations

// Define region of interest (Punjab, India)
var punjab = ee.FeatureCollection("FAO/GAUL/2015/level1")
  .filter(ee.Filter.and(
    ee.Filter.eq('ADM0_NAME', 'India'),
    ee.Filter.eq('ADM1_NAME', 'Punjab')
  ));

Map.centerObject(punjab, 8);
Map.addLayer(punjab, {color: 'blue'}, 'Punjab Boundary');

// Load Sentinel-2 data
var sentinel = ee.ImageCollection("COPERNICUS/S2_SR")
  .filterDate('2024-01-01', '2024-04-01')
  .filterBounds(punjab)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
  .median()
  .clip(punjab);

// Add true color composite to map
Map.addLayer(sentinel, {bands: ['B4', 'B3', 'B2'], min: 0, max: 3000}, 'True Color');

// Load Landsat 8 thermal data
var landsat = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2")
  .filterDate('2024-01-01', '2024-04-01')
  .filterBounds(punjab)
  .filter(ee.Filter.lt('CLOUD_COVER', 20))
  .median()
  .clip(punjab);

// Convert thermal band to Celsius
var thermal = landsat.select('ST_B10').multiply(0.00341802).add(149.0).subtract(273.15).rename('thermal');

// Calculate indices
var ndvi = sentinel.normalizedDifference(['B8', 'B4']).rename('NDVI');
var ndbi = sentinel.normalizedDifference(['B11', 'B8']).rename('NDBI');
var bsi = sentinel.expression(
  '((B11 + B4) - (B8 + B2)) / ((B11 + B4) + (B8 + B2))', {
    'B11': sentinel.select('B11'),
    'B4': sentinel.select('B4'),
    'B8': sentinel.select('B8'),
    'B2': sentinel.select('B2')
}).rename('BSI');

// Create composite image with all bands and indices for classification
var composite = ee.Image.cat([
  sentinel.select('B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B8A', 'B11', 'B12'),
  ndvi,
  ndbi,
  bsi,
  thermal
]);

// Prepare training data
// Assuming brick_kiln is a FeatureCollection with points marking brick kilns
// If brick_kiln is not already defined, uncomment and modify this line:
// var brick_kiln = ee.FeatureCollection('your_asset_path_here');

// Display the brick kiln points
Map.addLayer(brick_kiln, {color: 'red'}, 'Training Brick Kilns');

// Generate non-kiln points as negative examples
// Creates random points that are at least 500m away from known kiln points
var nonKilnBuffer = brick_kiln.geometry().buffer(500);
var nonKilnArea = punjab.geometry().difference(nonKilnBuffer);

var nonKilnPoints = ee.FeatureCollection.randomPoints({
  region: nonKilnArea,
  points: brick_kiln.size().multiply(3), // Create 3x as many negative examples
  seed: 123
}).map(function(feature) {
  return feature.set('class', 0); // 0 = not a brick kiln
});

// Set class property for brick kilns
var kilnPoints = brick_kiln.map(function(feature) {
  return feature.set('class', 1); // 1 = brick kiln
});

// Combine the datasets
var trainingPoints = kilnPoints.merge(nonKilnPoints);

// Sample the composite at the training points
var training = composite.sampleRegions({
  collection: trainingPoints,
  properties: ['class'],
  scale: 20
});

// Split data into training and validation sets (70% training, 30% validation)
var split = 0.7;
var withRandom = training.randomColumn('random');
var trainingSet = withRandom.filter(ee.Filter.lt('random', split));
var validationSet = withRandom.filter(ee.Filter.gte('random', split));

// Train a Random Forest classifier
var classifier = ee.Classifier.smileRandomForest({
  numberOfTrees: 100,
  variablesPerSplit: 3,
  minLeafPopulation: 1,
  bagFraction: 0.7,
  seed: 42
}).train({
  features: trainingSet,
  classProperty: 'class',
  inputProperties: composite.bandNames()
});

// Print training accuracy
var trainAccuracy = classifier.confusionMatrix();
print('Training error matrix:', trainAccuracy);
print('Training overall accuracy:', trainAccuracy.accuracy());

// Validate the model
var validation = validationSet.classify(classifier);
var validationAccuracy = validation.errorMatrix('class', 'classification');
print('Validation error matrix:', validationAccuracy);
print('Validation overall accuracy:', validationAccuracy.accuracy());

// Variable importance
var importance = ee.Dictionary(classifier.explain().get('importance'));
var importanceValues = importance.values();
var importanceBands = importance.keys();

// Sort by importance
var bandList = ee.List(importanceBands).zip(ee.List(importanceValues))
  .sort(function(a, b) {
    return ee.Number(ee.List(b).get(1)).subtract(ee.Number(ee.List(a).get(1)));
  });

print('Variable importance (sorted):', bandList);

// Apply the classifier to the image
var classified = composite.classify(classifier);

// Mask to only show likely brick kilns
var brickKilnMask = classified.eq(1);
var brickKilnImage = brickKilnMask.selfMask();

// Add predicted brick kilns to the map
Map.addLayer(brickKilnImage, {palette: 'red'}, 'Predicted Brick Kilns');

// Convert classification raster to vector points for easier analysis
var kilnVectors = brickKilnImage.reduceToVectors({
  geometry: punjab,
  scale: 20,
  geometryType: 'centroid',
  eightConnected: false,
  labelProperty: 'kiln',
  maxPixels: 1e9
});

Map.addLayer(kilnVectors, {color: 'yellow'}, 'Predicted Kiln Points');

// Export the model for future use
Export.classifier.toAsset({
  collection: ee.Classifier(classifier),
  description: 'brick_kiln_rf_classifier',
  assetId: 'users/your_username/brick_kiln_classifier'  // Change to your username
});

// Export results
Export.table.toDrive({
  collection: kilnVectors,
  description: 'Predicted_Brick_Kiln_Locations',
  fileFormat: 'SHP'
});

// Create a UI panel for accuracy metrics
var panel = ui.Panel({
  style: {
    position: 'top-right',
    padding: '8px 15px',
    width: '300px'
  }
});

var title = ui.Label({
  value: 'Brick Kiln Classification Results',
  style: {fontWeight: 'bold', fontSize: '16px', margin: '0 0 10px 0'}
});
panel.add(title);

// Add accuracy information to panel
classifier.explain().evaluate(function(explained) {
  panel.add(ui.Label('Training accuracy: ' + explained.training.accuracy.toFixed(4)));
  panel.add(ui.Label('Number of trees: ' + explained.numberOfTrees));
  
  // Top 5 important variables
  panel.add(ui.Label('Top 5 important variables:', {fontWeight: 'bold', margin: '10px 0 5px 0'}));
  var importance = explained.importance;
  var sortedImportance = Object.entries(importance)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  
  sortedImportance.forEach(function(item, index) {
    panel.add(ui.Label((index + 1) + '. ' + item[0] + ': ' + item[1].toFixed(4)));
  });
});

Map.add(panel);

// Add legend
var legend = ui.Panel({
  style: {
    position: 'bottom-right',
    padding: '8px 15px'
  }
});

var legendTitle = ui.Label({
  value: 'Legend',
  style: {fontWeight: 'bold', fontSize: '14px', margin: '0 0 4px 0'}
});
legend.add(legendTitle);

var makeRow = function(color, name) {
  var colorBox = ui.Label({
    style: {
      backgroundColor: color,
      padding: '8px',
      margin: '0 0 4px 0'
    }
  });
  var description = ui.Label({
    value: name,
    style: {margin: '0 0 4px 6px'}
  });
  return ui.Panel({
    widgets: [colorBox, description],
    layout: ui.Panel.Layout.Flow('horizontal')
  });
};

legend.add(makeRow('blue', 'Punjab Boundary'));
legend.add(makeRow('red', 'Training Brick Kilns'));
legend.add(makeRow('red', 'Predicted Brick Kilns (Raster)'));
legend.add(makeRow('yellow', 'Predicted Brick Kilns (Points)'));

Map.add(legend);
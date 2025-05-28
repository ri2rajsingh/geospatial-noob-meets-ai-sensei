// Model Validation Script for Brick Kiln Detection
// Evaluates model performance and provides detailed metrics

// Load your training data
var kilnCollection = brick_kilns_present;
var nonKilnCollection = brick_kilns_not_present;

// Study area
var ludhiana = ee.Geometry.Rectangle([75.6, 30.7, 76.0, 31.0]);

// Prepare imagery (same as main script)
var bands = ['B2', 'B3', 'B4', 'B8', 'B11', 'B12'];
var s2 = ee.ImageCollection('COPERNICUS/S2_SR')
  .filterDate('2023-01-01', '2023-12-31')
  .filterBounds(ludhiana)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
  .select(bands);

var s2Median = s2.median().clip(ludhiana);

// Feature engineering (same as main script)
var ndvi = s2Median.normalizedDifference(['B8', 'B4']).rename('NDVI');
var ndbi = s2Median.normalizedDifference(['B11', 'B8']).rename('NDBI');
var bsi = s2Median.expression(
  '((SWIR1 + RED) - (NIR + BLUE)) / ((SWIR1 + RED) + (NIR + BLUE))',
  {
    'SWIR1': s2Median.select('B11'),
    'RED': s2Median.select('B4'),
    'NIR': s2Median.select('B8'),
    'BLUE': s2Median.select('B2')
  }).rename('BSI');

var redIndex = s2Median.expression(
  'RED / (GREEN + BLUE)',
  {
    'RED': s2Median.select('B4'),
    'GREEN': s2Median.select('B3'),
    'BLUE': s2Median.select('B2')
  }).rename('RedIndex');

var featureStack = s2Median.addBands([ndvi, ndbi, bsi, redIndex]);

// Prepare training data
var positive = kilnCollection.map(function(f) { return f.set('class', 1); });
var negative = nonKilnCollection.map(function(f) { return f.set('class', 0); });
var trainingPoints = positive.merge(negative);

// Extract features
var training = featureStack.sampleRegions({
  collection: trainingPoints,
  properties: ['class'],
  scale: 10
});

print('=== TRAINING DATA ANALYSIS ===');
print('Total training points:', training.size());
print('Class distribution:', training.aggregate_histogram('class'));

// Split data for validation
var withRandom = training.randomColumn('random', 42);
var trainSet = withRandom.filter(ee.Filter.lt('random', 0.7));
var testSet = withRandom.filter(ee.Filter.gte('random', 0.7));

print('Training set size:', trainSet.size());
print('Test set size:', testSet.size());

// Train model
var classifier = ee.Classifier.smileRandomForest(50)
  .train({
    features: trainSet,
    classProperty: 'class',
    inputProperties: featureStack.bandNames()
  });

// Validate on test set
var validated = testSet.classify(classifier);
var confusionMatrix = validated.errorMatrix('class', 'classification');

print('=== MODEL PERFORMANCE ===');
print('Confusion Matrix:', confusionMatrix);
print('Overall Accuracy:', confusionMatrix.accuracy());
print('Kappa Coefficient:', confusionMatrix.kappa());

// Detailed metrics
var producersAccuracy = confusionMatrix.producersAccuracy();
var consumersAccuracy = confusionMatrix.consumersAccuracy();

print('Producers Accuracy (Recall):', producersAccuracy);
print('Consumers Accuracy (Precision):', consumersAccuracy);

// F1 Score calculation
var precision = consumersAccuracy.get([1,0]); // Class 1 precision
var recall = producersAccuracy.get([1,0]); // Class 1 recall
var f1 = ee.Number(2).multiply(precision).multiply(recall)
  .divide(ee.Number(precision).add(recall));

print('F1-Score for brick kilns:', f1);

// Feature importance
print('=== FEATURE IMPORTANCE ===');
var importance = classifier.explain();
print('Feature importance:', importance.get('importance'));

// Cross-validation
print('=== CROSS-VALIDATION ===');
var folds = 5;
var cvResults = ee.List.sequence(0, folds-1).map(function(fold) {
  fold = ee.Number(fold);
  var trainCV = withRandom.filter(
    ee.Filter.or(
      ee.Filter.lt('random', fold.divide(folds)),
      ee.Filter.gte('random', fold.add(1).divide(folds))
    )
  );
  var testCV = withRandom.filter(
    ee.Filter.and(
      ee.Filter.gte('random', fold.divide(folds)),
      ee.Filter.lt('random', fold.add(1).divide(folds))
    )
  );
  
  var cvClassifier = ee.Classifier.smileRandomForest(50)
    .train({
      features: trainCV,
      classProperty: 'class',
      inputProperties: featureStack.bandNames()
    });
  
  var cvAccuracy = testCV.classify(cvClassifier)
    .errorMatrix('class', 'classification')
    .accuracy();
    
  return cvAccuracy;
});

print('Cross-validation accuracies:', cvResults);
var meanCV = ee.Number(cvResults.reduce(ee.Reducer.mean()));
var stdCV = ee.Number(cvResults.reduce(ee.Reducer.stdDev()));
print('Mean CV accuracy:', meanCV);
print('CV standard deviation:', stdCV);

// Export validation results
Export.table.toDrive({
  collection: validated,
  description: 'validation_results',
  folder: 'GEE_Validation',
  fileFormat: 'CSV'
});
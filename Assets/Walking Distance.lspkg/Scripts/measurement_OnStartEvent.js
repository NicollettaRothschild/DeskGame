// @input bool storeData
// @input SceneObject cameraObject
// @input SceneObject anchorObject
// @input bool displayDistance
// @input Component.Text distanceText
// @input bool displaySteps
// @input Component.Text stepsText
// @input bool displaySpeed
// @input Component.Text speedText
// @input bool displayCalories
// @input Component.Text caloriesText
// @input bool displayTime
// @input Component.Text timeSinceText
// @input bool sameDay
// @input float fulldist = 0
// @input float totaldist = 0
// @input float caldist = 0
// @input float calories = 0
// @input float timer = 0
// @input float speedFloat = 0
// @input int steps = 0
// @input float score = 0
// @input string date;
// @input float calcheck;
script.createEvent("OnStartEvent").bind(function() { require("measurement_wrapped")(script)})
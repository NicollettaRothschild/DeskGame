function scriptBody(script){ 

var store = global.persistentStorageSystem.store;
var scoreKey = "dayDistance";
var scoreKeyDay = "day";

script.createEvent("UpdateEvent").bind(function(){

});

var delayedEvent = script.createEvent("DelayedCallbackEvent");
delayedEvent.bind(function(eventData)
{
    delayedEvent.reset(1);
    var posA = script.cameraObject.getTransform().getWorldPosition();
    var posB = script.anchorObject.getTransform().getWorldPosition();
    var distance = posA.distance(posB);
    var timesince = getTime().toFixed(0).toString();
    var minutes = Math.floor(timesince / 60);
    var seconds = timesince - minutes * 60;
    
    if(script.displayTime == true)
    {
         if(seconds < 10)
        {
            script.timeSinceText.text = "Session Time: " + minutes + ":0" + seconds;  
        }
        else 
        {
            script.timeSinceText.text = "Session Time: " + minutes + ":" + seconds;        
        }   
    }

    if(distance > 5)
    {
        script.fulldist += distance;
        script.totaldist = script.fulldist/100;
        script.caldist += script.totaldist;
        script.steps = script.totaldist/0.7;
        script.anchorObject.getTransform().setWorldPosition(script.cameraObject.getTransform().getWorldPosition());
        if(script.displayDistance == true)
        {
            script.distanceText.text = "Distance: " + script.totaldist.toFixed(1) + "m"; 
        }
        if(script.displaySteps == true)
        {
            script.stepsText.text = "Est. Steps: " + script.steps.toFixed(0);
        }
        
        script.score += distance;
        if(script.storeData == true)
        {
             increaseStored();
        }
    }
    
    if(distance > 0.1)
    {
        script.speedfloat = distance/50;
        if(script.displaySpeed == true)
        {
            script.speedText.text = "Speed: " + script.speedfloat.toFixed(1) + "km/h";
        }
    }
    else
    {
        if(script.displaySpeed == true)
        {
            script.speedText.text = "Speed: " + 0 + "km/h";
        }
    }
    
    if(script.caldist > 14)
    {
        script.calories = script.totaldist/14;
        if(script.displayCalories == true)
        {
            script.caloriesText.text = "Calories: " + script.calories.toFixed(1);
        }
        var tmp = script.calories - script.calcheck;
        if(tmp > 1)
        {
            script.calcheck = script.calories;
        }
    }

    
});

// Start with a 2 second delay
delayedEvent.reset(2);

function onStart(eventData)
{
    var today = new Date();  
    script.date = today.getFullYear()+'-'+(today.getMonth()+1)+'-'+ today.getDate();
    var previousDate = store.getString(scoreKeyDay);
    
    if(script.date == previousDate)
    {
        script.sameDay = true;
    }
    else
    {
        script.sameDay = false;
    }
    
    if(script.sameDay == true && script.storeData == true)
    {
        script.fulldist = store.getFloat(scoreKey);   
    }

    script.score = script.fulldist;
    script.totaldist = script.fulldist/100;
    script.caldist += script.totaldist;
    script.steps = script.totaldist/0.7;
    script.calories = script.totaldist/14;
    
    if(script.displayDistance == true)
    {
        script.distanceText.text = "Distance: " + script.totaldist.toFixed(2) + "m"; 
    }
    if(script.displaySteps == true)
    {
        script.stepsText.text = "Est. Steps: " + script.steps.toFixed(0);
    }
    if(script.displayCalories == true)
    {
        script.caloriesText.text = "Calories Burned: " + script.calories.toFixed(1);
    }   
   
    script.calcheck = script.calories.toFixed(0);
}

var event = script.createEvent("OnStartEvent");
event.bind(onStart);

function increaseStored() {
    // Increase score, then write it to the data store
    store.putFloat(scoreKey, script.score);
    store.putString(scoreKeyDay, script.date);
}

 }; module.exports = scriptBody;